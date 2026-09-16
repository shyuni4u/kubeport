import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getNow, getTimeZone } from "next-intl/server";
import "./globals.css";
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { ERROR_DETAIL_COOKIE } from "@/lib/error-detail";
import { parseTheme, THEME_COOKIE, themeClass } from "@/lib/theme";
import { Providers } from "./providers";

const pretendard = localFont({
  src: "./fonts/PretendardVariable.woff2",
  variable: "--font-pretendard",
  weight: "45 920",
  display: "swap",
  preload: false,
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
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  const themeCls = themeClass(theme);
  // Same reason: the error detail level (#6) is rendered on the server first.
  const errorDetailCookie = cookieStore.get(ERROR_DETAIL_COOKIE)?.value;

  return (
    <html
      lang={locale}
      className={`${pretendard.variable} ${geistMono.variable} h-full antialiased${themeCls ? ` ${themeCls}` : ""}`}
    >
      <body className="min-h-full bg-background text-foreground">
        <NextIntlClientProvider
          locale={locale}
          messages={messages}
          timeZone={timeZone}
          now={now}
        >
          <Providers>
            <AppShell theme={theme} errorDetailCookie={errorDetailCookie}>
              {children}
            </AppShell>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
