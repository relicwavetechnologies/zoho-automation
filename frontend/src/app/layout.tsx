import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/context/AuthContext";
import { ChatProvider } from "@/context/ChatContext";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetBrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Halo",
  description: "AI chat application",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" style={{ backgroundColor: "var(--bg-base)" }}>
      <body className={`${inter.variable} ${jetBrainsMono.variable} antialiased`}>
        <TooltipProvider>
          <AuthProvider>
            <ChatProvider>
              {children}
              <Toaster
                position="bottom-right"
                theme="dark"
                richColors
                toastOptions={{
                  style: {
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-primary)",
                  },
                }}
              />
            </ChatProvider>
          </AuthProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
