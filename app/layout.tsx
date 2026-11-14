export const metadata = { title: "Vigil", description: "NASA MODIS & VIIRS 25-Year Fire Regime Harmonizer" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f8fafc" }}>{children}</body>
    </html>
  );
}
