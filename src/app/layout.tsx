import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/providers";
import { ToastContainer } from "@/components/ui";
import { AssistantProvider } from "@/lib/assistant/context";
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
      <body>
        <ThemeProvider>
          <AssistantProvider>
            {children}
            <ToastContainer />
          </AssistantProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
