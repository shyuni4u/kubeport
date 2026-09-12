import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getNow, getTimeZone } from "next-intl/server";
import "./globals.css";
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { parseTheme, THEME_COOKIE, themeClass } from "@/lib/theme";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "kubeport",
  description: "Self-service portal for Kubernetes resources",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();
  // Forwarded explicitly: the client provider does not inherit the request
  // config, and without them client components fall back to the browser's
  // zone and clock — see the comments on TIME_ZONE.
  const timeZone = await getTimeZone();
  const now = await getNow();
  // Read on the server so the first paint is already in the chosen theme and
  // hydration sees the class it was sent (#155, and #247 for the alternative).
  // This layout was already request-time — next-intl's config reads the locale
  // cookie — so this adds no dynamic rendering that was not there.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const themeCls = themeClass(theme);

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased${themeCls ? ` ${themeCls}` : ""}`}
    >
      <body className="min-h-full bg-background text-foreground">
        <NextIntlClientProvider
          locale={locale}
          messages={messages}
          timeZone={timeZone}
          now={now}
        >
          <Providers>
            <AppShell theme={theme}>{children}</AppShell>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
