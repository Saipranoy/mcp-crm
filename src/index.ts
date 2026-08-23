import "dotenv/config";
import { PublicClientApplication } from "@azure/msal-node";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

type Account = {
  name: string;
  city: string;
  active: boolean;
};

const accounts: Account[] = [
  { name: "Vision Optics", city: "London", active: true },
  { name: "Bright Eyes", city: "Manchester", active: false },
  { name: "Clear View", city: "London", active: true },
];

const entraClientId = process.env.ENTRA_CLIENT_ID;
const entraTenantId = process.env.ENTRA_TENANT_ID;
const crmApiBaseUrl = process.env.CRM_API_BASE_URL;

if (!entraClientId || !entraTenantId || !crmApiBaseUrl) {
  throw new Error("Missing Entra or CRM settings in .env");
}

const msalClient = new PublicClientApplication({
  auth: {
    clientId: entraClientId,
    authority: `https://login.microsoftonline.com/${entraTenantId}`,
  },
});

type CrmLoginResponse = {
  access_token: string;
  user: {
    username: string;
    full_name: string | null;
    role: string;
    sales_rep_name: string | null;
  };
};

type CrmAccount = {
  id: string;
  name: string;
  status: string | null;
  sales_rep: string | null;
};

type CrmAccountsResponse = {
  data: CrmAccount[];
  total: number;
  limit: number;
  offset: number;
};

let crmAccessToken: string | null = null;
let signedInUser: CrmLoginResponse["user"] | null = null;
let loginInProgress = false;
let loginError: string | null = null;

async function exchangeMicrosoftToken(idToken: string): Promise<CrmLoginResponse> {
  const response = await fetch(`${crmApiBaseUrl}/api/auth/entra`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: idToken }),
  });

  if (!response.ok) {
    throw new Error(`CRM login failed: ${response.status}`);
  }

  return (await response.json()) as CrmLoginResponse;
}

async function startCrmLogin(): Promise<string> {
  if (crmAccessToken && signedInUser) {
    return `Already signed in as ${signedInUser.full_name ?? signedInUser.username}.`;
  }

  if (loginInProgress) {
    return "Microsoft sign-in is already in progress. Complete it, then run crm_login_status.";
  }

  loginInProgress = true;
  loginError = null;

  let sendDeviceMessage!: (message: string) => void;

  const deviceMessage = new Promise<string>((resolve) => {
    sendDeviceMessage = resolve;
  });

  void msalClient
    .acquireTokenByDeviceCode({
      scopes: ["openid", "profile", "email"],
      deviceCodeCallback: (message) => {
        console.error(message.message);
        sendDeviceMessage(message.message);
      },
    })
    .then(async (microsoftResult) => {
      if (!microsoftResult?.idToken) {
        throw new Error("Microsoft sign-in did not return an identity token.");
      }

      const session = await exchangeMicrosoftToken(microsoftResult.idToken);
      crmAccessToken = session.access_token;
      signedInUser = session.user;

      console.error(`CRM sign-in complete: ${session.user.username}`);
    })
    .catch((error) => {
      loginError = error instanceof Error ? error.message : "Microsoft sign-in failed.";
      console.error("CRM login error:", error);
      sendDeviceMessage(`Could not start Microsoft sign-in: ${loginError}`);
    })
    .finally(() => {
      loginInProgress = false;
    });

  return deviceMessage;
}

async function searchCrmAccounts(query: string): Promise<CrmAccountsResponse> {
  if (!crmAccessToken) {
    throw new Error("Please run start_crm_login first.");
  }

  const url = new URL("/api/accounts", crmApiBaseUrl);
  url.searchParams.set("search", query);
  url.searchParams.set("fields", "id,name,status,sales_rep");
  url.searchParams.set("limit", "25");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${crmAccessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`CRM account search failed: ${response.status}`);
  }

  return (await response.json()) as CrmAccountsResponse;
}

function createServer() {
  const server = new McpServer({
    name: "crm-learning-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "start_crm_login",
    {
      description: "Start Microsoft Entra sign-in for the CRM.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: await startCrmLogin(),
        },
      ],
    })
  );

  server.registerTool(
    "crm_login_status",
    {
      description: "Check whether CRM Microsoft sign-in has completed.",
      inputSchema: z.object({}),
    },
    async () => {
      if (signedInUser) {
        return {
          content: [
            {
              type: "text",
              text: `Signed in as ${signedInUser.full_name ?? signedInUser.username} (${signedInUser.role}).`,
            },
          ],
        };
      }

      if (loginError) {
        return {
          content: [{ type: "text", text: loginError }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: loginInProgress
              ? "Still waiting for Microsoft sign-in to finish."
              : "No CRM sign-in has been started.",
          },
        ],
      };
    }
  );

  server.registerTool(
    "search_accounts",
    {
      description: "Search the practice CRM accounts by name.",
      inputSchema: z.object({
        query: z.string().min(1),
      }),
    },
    async ({ query }) => {
      const results = accounts.filter((account) =>
        account.name.toLowerCase().includes(query.toLowerCase())
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "search_crm_accounts",
    {
      description: "Search real CRM accounts by name. Results follow the signed-in user's CRM permissions.",
      inputSchema: z.object({
        query: z.string().min(1).max(100),
      }),
    },
    async ({ query }) => {
      try {
        const results = await searchCrmAccounts(query);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  total_matches: results.total,
                  accounts: results.data,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "CRM account search failed.",
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

void serveStdio(createServer);
console.error("CRM learning MCP server running");