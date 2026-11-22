import json
import re
import unittest
from html.parser import HTMLParser
from urllib.parse import urlsplit
from xml.etree import ElementTree

from web.main import app


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: set[str] = set()
        self.ids: set[str] = set()
        self.images: list[dict[str, str | None]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if identifier := attributes.get("id"):
            self.ids.add(identifier)
        if tag == "a" and (href := attributes.get("href")):
            self.links.add(href)
        if tag == "img":
            self.images.append(attributes)


class ContentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = app.test_client()
        cls.response = cls.client.get("/")
        cls.page = PageParser()
        cls.page.feed(cls.response.get_data(as_text=True))

    def test_home_renders(self) -> None:
        self.assertEqual(self.response.status_code, 200)

    def test_about_links_to_my_sites_and_the_cards_match_structured_data(self) -> None:
        html = self.response.get_data(as_text=True)
        match = re.search(r'id="sites".*?</section>', html, re.S)
        assert match is not None
        actual = re.findall(r'class="site-card-link" href="([^"]+)"', match.group())
        script = re.search(
            r'<script type="application/ld\+json">(.*?)</script>', html, re.S
        )
        assert script is not None
        site_list = next(
            item
            for item in json.loads(script.group(1))["@graph"]
            if item["@type"] == "ItemList"
        )
        self.assertEqual(actual, [item["url"] for item in site_list["itemListElement"]])
        self.assertNotIn("https://zacwalk.com/", actual)
        self.assertIn('href="#sites">My Sites</a>', html[html.index('id="about"'):])

    def test_normal_and_error_pages_share_the_portrait_favicon(self) -> None:
        icon_urls = set()
        for path, status in (("/", 200), ("/missing", 404)):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, status)
                icons = re.findall(
                    r'<link rel="icon" href="([^"]+)" type="image/svg\+xml"',
                    response.get_data(as_text=True),
                )
                self.assertEqual(len(icons), 1)
                icon_urls.add(icons[0])
                url = urlsplit(icons[0])
                self.assertEqual(url.path, "/static/zacwalk-portrait.svg")
                self.assertRegex(url.query, r"^v=[\w-]+$")
                with self.client.get(icons[0]) as icon:
                    self.assertEqual(icon.status_code, 200)
                    self.assertEqual(icon.mimetype, "image/svg+xml")
                    root = ElementTree.fromstring(icon.get_data())
                    _, _, width, height = map(float, root.attrib["viewBox"].split())
                    self.assertGreater(width, 0)
                    self.assertEqual(width, height)
                    self.assertEqual(
                        root.findtext("{http://www.w3.org/2000/svg}title"),
                        "ZacWalk portrait icon",
                    )
                    with self.client.get("/favicon.ico") as fallback:
                        self.assertEqual(fallback.status_code, 200)
                        self.assertEqual(fallback.mimetype, "image/svg+xml")
                        self.assertEqual(fallback.get_data(), icon.get_data())
        self.assertEqual(len(icon_urls), 1)

    def test_zacwalk_branding_and_canonical_metadata(self) -> None:
        response = self.client.get("/", base_url="https://zacwalk.com")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("<h1>ZacWalk</h1>", html)
        self.assertIn(
            "<title>Zac Walker — Software Projects &amp; Open Source | ZacWalk</title>",
            html,
        )
        self.assertIn('rel="canonical" href="https://zacwalk.com/"', html)
        self.assertIn('property="og:site_name" content="ZacWalk"', html)
        self.assertNotIn("Rethinkify", html)
        match = re.search(
            r'<script type="application/ld\+json">\s*(.*?)\s*</script>', html, re.S
        )
        assert match is not None
        graph = json.loads(match.group(1))["@graph"]
        website = next(item for item in graph if item["@type"] == "WebSite")
        self.assertEqual(website["name"], "ZacWalk")
        self.assertEqual(website["url"], "https://zacwalk.com/")
        sites = next(item for item in graph if item["@type"] == "ItemList")
        self.assertIn(
            {
                "@type": "ListItem",
                "position": 2,
                "name": "64Ready",
                "url": "https://64ready.com/",
            },
            sites["itemListElement"],
        )
        robots = self.client.get("/robots.txt", base_url="https://zacwalk.com")
        self.assertIn(
            "Sitemap: https://zacwalk.com/sitemap.xml", robots.get_data(as_text=True)
        )
        sitemap = self.client.get("/sitemap.xml", base_url="https://zacwalk.com")
        self.assertIn("<loc>https://zacwalk.com/</loc>", sitemap.get_data(as_text=True))

    def test_old_and_www_hosts_redirect_to_zacwalk_without_losing_the_query(
        self,
    ) -> None:
        for origin in (
            "https://rethinkify.com",
            "https://www.rethinkify.com",
            "https://www.zacwalk.com",
        ):
            with self.subTest(origin=origin):
                response = self.client.get("/about?ref=old%20link", base_url=origin)
                self.assertEqual(response.status_code, 301)
                self.assertEqual(
                    response.headers["Location"],
                    "https://zacwalk.com/about?ref=old%20link",
                )
                self.assertEqual(
                    self.client.get("/health", base_url=origin).status_code, 200
                )

    def test_project_links_use_verified_public_repositories(self) -> None:
        repositories = {
            urlsplit(link).path.split("/")[2]
            for link in self.page.links
            if link.startswith("https://github.com/ZacWalk/")
        }
        self.assertEqual(
            repositories,
            {
                "dd",
                "dde",
                "diffractor",
                "dos4z",
                "electron-bench",
                "ergo-active",
                "fast-draw",
                "http-sys-rust",
                "imagewalker",
                "lib8bit",
                "libdesktop",
                "libdos",
                "libfiles",
                "low-ban",
                "nncpu",
                "potato",
                "stuntcarracer",
                "sys-mate",
                "trade-db",
                "trade-rl",
                "vector-experiments",
                "zpilot",
            },
        )

    def test_images_exist_and_have_dimensions_and_alt_text(self) -> None:
        for image in self.page.images:
            with self.subTest(src=image.get("src")):
                source = image.get("src")
                self.assertIsNotNone(source)
                self.assertTrue(image.get("alt"))
                self.assertGreater(int(image.get("width") or "0"), 0)
                self.assertGreater(int(image.get("height") or "0"), 0)
                response = self.client.get(source or "")
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.mimetype.startswith("image/"))
                response.close()

    def test_site_logos_are_svg_with_matching_aspect_ratios(self) -> None:
        sources = {
            "/static/images/alpha-galactica-logo.svg",
            "/static/images/64ready-logo.svg",
        }
        logos = [image for image in self.page.images if urlsplit(image.get("src") or "").path in sources]
        self.assertEqual(len(logos), len(sources))
        for image in logos:
            with self.subTest(src=image["src"]):
                response = self.client.get(image["src"] or "")
                self.assertEqual(response.mimetype, "image/svg+xml")
                root = ElementTree.fromstring(response.get_data())
                _, _, width, height = map(float, root.attrib["viewBox"].split())
                self.assertAlmostEqual(
                    int(image["width"] or "0") / int(image["height"] or "1"),
                    width / height,
                )
                response.close()

    def test_internal_anchors_resolve(self) -> None:
        for link in self.page.links:
            if link.startswith("#"):
                with self.subTest(href=link):
                    self.assertIn(link[1:], self.page.ids)

    def test_existing_routes(self) -> None:
        with self.subTest(route="/about"):
            response = self.client.get("/about")
            self.assertEqual(response.status_code, 301)
            self.assertEqual(response.headers["Location"], "/#about")
        for route, status, mimetype in (
            ("/health", 200, "text/html"),
            ("/robots.txt", 200, "text/plain"),
            ("/sitemap.xml", 200, "application/xml"),
            ("/missing", 404, "text/html"),
        ):
            with self.subTest(route=route):
                response = self.client.get(route)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.mimetype, mimetype)


if __name__ == "__main__":
    unittest.main()
