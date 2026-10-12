import "./globals.css";

export const metadata = {
  title: "Wander HQ",
  description: "Description + hashtag generator for Wine Wilderness Wanderlust",
};

// viewportFit "cover" lets the phone bottom tab bar (globals.css) pad
// itself clear of the iPhone home indicator via safe-area insets; the
// theme color tints the phone's browser bar to match the teal band.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#5CC4C4",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
