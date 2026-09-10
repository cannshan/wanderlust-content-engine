import "./globals.css";

export const metadata = {
  title: "WWW Content Engine",
  description: "Description + hashtag generator for Wine Wilderness Wanderlust",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
