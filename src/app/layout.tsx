import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { ThemeDomSynchronizer } from "@/components/theme-switcher";

export const metadata: Metadata = {
  title: "Aktivacity Portal",
  description: "Aktivacity central project portal",
  appleWebApp: { capable: true, title: "Aktivacity", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1f5eff",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get("aktivacity_theme")?.value;
  // Default is 'dark'
  const isLight = themeCookie === "light";
  const themeClass = isLight ? "light" : "dark";

  return (
    <html
      lang="en"
      className={`h-full antialiased ${themeClass}`}
      data-theme={themeClass}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var saved = localStorage.getItem('aktivacity_display_theme');
                  var cookieTheme = (document.cookie.match(/aktivacity_theme=([^;]+)/) || [])[1];
                  var theme = saved || cookieTheme || 'dark';
                  if (theme === 'light') {
                    document.documentElement.classList.remove('dark');
                    document.documentElement.classList.add('light');
                    document.documentElement.setAttribute('data-theme', 'light');
                  } else {
                    document.documentElement.classList.remove('light');
                    document.documentElement.classList.add('dark');
                    document.documentElement.setAttribute('data-theme', 'dark');
                  }
                } catch(e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground transition-colors duration-150" suppressHydrationWarning>
        <ThemeDomSynchronizer />
        {children}
      </body>
    </html>
  );
}
