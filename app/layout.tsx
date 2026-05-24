import "./globals.css";
import type { Metadata } from "next";
import Image from "next/image";
import ThemeToggle from "@/components/ui/ThemeToggle";

export const metadata: Metadata = {
  title: "Flexx Landscaping KPIs",
  description:
    "Business intelligence dashboard for Flexx Landscaping — revenue, customers, and operations",
};

const themeInitScript = `
(function() {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored || (prefersDark ? 'dark' : 'light');
    if (theme === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-page-bg font-sans antialiased">
        <Header />
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="border-b border-border bg-flexx-black text-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10 overflow-hidden rounded-md">
            <Image
              src="/flexx-logo.jpeg"
              alt="Flexx Landscaping"
              width={40}
              height={40}
              className="h-full w-full object-cover"
              priority
            />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight">
              Flexx Landscaping KPIs
            </h1>
            <p className="text-xs text-white/60">
              Business intelligence dashboard
            </p>
          </div>
        </div>
        <nav className="flex items-center gap-1 text-sm">
          <a
            href="/"
            className="rounded-md px-3 py-1.5 font-medium hover:bg-white/10"
          >
            Dashboard
          </a>
          <a
            href="/audits"
            className="rounded-md px-3 py-1.5 font-medium text-white/70 hover:bg-white/10 hover:text-white"
          >
            Audits
          </a>
          <a
            href="/settings"
            className="rounded-md px-3 py-1.5 font-medium text-white/70 hover:bg-white/10 hover:text-white"
          >
            Settings
          </a>
          <div className="ml-1">
            <ThemeToggle />
          </div>
        </nav>
      </div>
    </header>
  );
}
