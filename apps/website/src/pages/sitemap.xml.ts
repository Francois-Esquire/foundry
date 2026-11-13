import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const urls = ["/", "/marbles/", "/spyglass/", "/works/"]
    .map((path) => `<url><loc>${new URL(path, site)}</loc></url>`)
    .join("");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    { headers: { "Content-Type": "application/xml" } }
  );
};
