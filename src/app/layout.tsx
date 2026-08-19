import type { Metadata, Viewport } from "next";
import { ThemeProvider, QueryProvider, BasePathProvider } from "@/components/providers";
import { withBasePath } from "@/lib/platform/base-path";
import { ToastContainer } from "@/components/ui";
import { AssistantProvider } from "@/lib/assistant/context";
import { AssistantChat } from "@/components/assistant";
import { GlobalFinder } from "@/components/finder/GlobalFinder";
import { ServiceWorkerRegistration } from "@/components/pwa";
import "./globals.css";

export const metadata: Metadata = {
  title: "Open Workspace",
  description: "Umfassender AI-Workspace für Agenten-Kollaboration",
  // Unter Ingress liegt auch das Manifest hinter dem Präfix (M12).
  manifest: withBasePath("/manifest.webmanifest"),
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
  // Layout bis unter Notch/Home-Indicator; Abstände via env(safe-area-inset-*).
  // Bewusst KEIN maximumScale/userScalable — Pinch-Zoom ist Accessibility.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <BasePathProvider>
        <ThemeProvider>
          <QueryProvider>
            <AssistantProvider>
              {children}
              <AssistantChat />
              <GlobalFinder />
              <ToastContainer />
              <ServiceWorkerRegistration />
            </AssistantProvider>
          </QueryProvider>
        </ThemeProvider>
        </BasePathProvider>
      </body>
    </html>
  );
}

