import type { Metadata, Viewport } from "next";
import { ThemeProvider, QueryProvider } from "@/components/providers";
import { ToastContainer } from "@/components/ui";
import { AssistantProvider } from "@/lib/assistant/context";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotStateProvider } from "@/components/copilot";
import { AssistantChat } from "@/components/assistant";
import { GlobalFinder } from "@/components/finder/GlobalFinder";
import { ServiceWorkerRegistration } from "@/components/pwa";
import "./globals.css";

export const metadata: Metadata = {
  title: "Open Workspace",
  description: "Umfassender AI-Workspace für Agenten-Kollaboration",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Open Workspace",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAFA" },
    { media: "(prefers-color-scheme: dark)", color: "#1A1A1A" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ThemeProvider>
          <QueryProvider>
          <CopilotKit runtimeUrl="/api/copilotkit" showDevConsole={false}>
            <AssistantProvider>
              <CopilotStateProvider>
                {children}
                <AssistantChat />
                <GlobalFinder />
              </CopilotStateProvider>
              <ToastContainer />
              <ServiceWorkerRegistration />
            </AssistantProvider>
          </CopilotKit>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

