import type { Metadata } from "next";
import "./globals.css";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";
import { TenantProvider } from "@/context/TenantContext";
import { AuthProvider } from "@/context/AuthContext";
import { TenantBrandProvider } from "@/components/shared/TenantBrandProvider";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Brillianda — School Registry, LMS & CBT",
  description: "The next generation learning management system for schools.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("font-sans", inter.variable)}>
      <body className={cn("antialiased bg-white text-slate-900", inter.variable)}>
        <TenantProvider initialTenant={null}>
          <AuthProvider>
            <TenantBrandProvider>{children}</TenantBrandProvider>
          </AuthProvider>
        </TenantProvider>
      </body>
    </html>
  );
}
