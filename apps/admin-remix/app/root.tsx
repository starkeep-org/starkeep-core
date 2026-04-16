import type { LinksFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  Form,
  Link,
  useLoaderData,
} from "@remix-run/react";
import { Alert, Button, Group, MantineProvider, ColorSchemeScript, Container, Paper, Stack } from "@mantine/core";
import "@mantine/core/styles.css";
import { AuthRepository } from "@starkeep/admin-db";
import { getSession } from "./lib/session.server";
import { validate as validateUuid } from "uuid";

export const links: LinksFunction = () => [];

export async function loader({ request }: LoaderFunctionArgs) {
  const emailEnabled = Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
  if (!process.env.DATABASE_URL) {
    return json({ isAuthenticated: false, emailEnabled });
  }

  const session = await getSession(request);
  const sessionId = session.get("sessionId");
  if (typeof sessionId !== "string" || !validateUuid(sessionId)) {
    return json({ isAuthenticated: false, emailEnabled });
  }

  const authRepo = new AuthRepository();
  const authSession = await authRepo.findSessionById(sessionId);
  return json({ isAuthenticated: Boolean(authSession), emailEnabled });
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <ColorSchemeScript />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { isAuthenticated, emailEnabled } = useLoaderData<typeof loader>();

  return (
    <MantineProvider>
      {isAuthenticated && (
        <Paper withBorder radius={0}>
          <Container size="lg" py="sm">
            <Stack gap="sm">
              {!emailEnabled && (
                <Alert color="yellow">
                  Email features are disabled. Set `RESEND_API_KEY` and `EMAIL_FROM` to enable invites and magic links.
                </Alert>
              )}
              <Group justify="space-between">
                <Group gap="sm">
                  <Button component={Link} to="/deployments" variant="subtle" size="sm">
                    Deployments
                  </Button>
                  <Button component={Link} to="/apps" variant="subtle" size="sm">
                    Apps
                  </Button>
                  <Button component={Link} to="/types" variant="subtle" size="sm">
                    Types
                  </Button>
                  <Button component={Link} to="/permissions" variant="subtle" size="sm">
                    Permissions
                  </Button>
                  <Button component={Link} to="/infrastructure" variant="subtle" size="sm">
                    Infrastructure
                  </Button>
                  <Button component={Link} to="/settings/aws" variant="subtle" size="sm">
                    AWS
                  </Button>
                </Group>
                <Form method="post" action="/auth/logout">
                  <Button type="submit" variant="light" size="sm">
                    Sign out
                  </Button>
                </Form>
              </Group>
            </Stack>
          </Container>
        </Paper>
      )}
      <Outlet />
    </MantineProvider>
  );
}
