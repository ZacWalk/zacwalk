from __future__ import annotations

import hashlib
import os
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

from flask import (
    Flask,
    Response,
    abort,
    redirect,
    render_template,
    request,
    send_from_directory,
)
from flask.typing import ResponseReturnValue

app = Flask(__name__)

_IS_PROD = os.getenv("GAE_ENV", "").startswith("standard")

# The menu and game scripts are served from this origin, so script-src stays at
# 'self' with nothing inline. JSON-LD is a data block rather than
# executable script, so the policy does not affect it.
_CSP = (
    "default-src 'none'; "
    "img-src 'self'; "
    "style-src 'self' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "script-src 'self'; "
    "base-uri 'none'; "
    "form-action 'none'; "
    "frame-ancestors 'self'"
)


@app.after_request
def _security_headers(response: Response) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Content-Security-Policy", _CSP)
    response.headers.setdefault(
        "Permissions-Policy",
        "geolocation=(), microphone=(), camera=(), payment=()",
    )
    if _IS_PROD:
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


# Canonical site origin used in absolute URLs (sitemap, canonical tags, OG, JSON-LD).
SITE_ORIGIN = "https://zacwalk.com"
_CANONICAL_HOST = urlsplit(SITE_ORIGIN).hostname
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0"}


@app.before_request
def _redirect_to_canonical_host() -> ResponseReturnValue | None:
    """Redirect legacy, www and App Engine hosts to the canonical origin.

    Otherwise search engines crawl each host as a separate copy of the site. /health keeps
    answering on any host for uptime checks; /static never reaches this hook (app.yaml).
    """
    host = (request.host or "").split(":")[0].lower()
    if (
        not host
        or host == _CANONICAL_HOST
        or host in _LOCAL_HOSTS
        or request.path == "/health"
    ):
        return None
    path = request.full_path if request.query_string else request.path
    return redirect(
        SITE_ORIGIN + path, code=301 if request.method in {"GET", "HEAD"} else 308
    )


_STYLESHEET = Path(app.static_folder or "static") / "styles.css"
_GAME = Path(app.static_folder or "static") / "game"


def _asset_version() -> str:
    """Cache-busting token so a long static expiry never serves a stale stylesheet.

    Taken from the file's contents, not its modification time: App Engine stamps every
    deployed file 1980-01-01, so an mtime token would never change between deploys.
    """
    try:
        return hashlib.sha256(_STYLESHEET.read_bytes()).hexdigest()[:12]
    except OSError:
        return "0"


def _game_version() -> str:
    """Version token for the game's scripts, from all of their contents.

    The modules import each other by relative URL, so the token goes in the path rather than
    a query string (/game/<token>/boot.js). Then every import carries it, and game_script
    below can let browsers keep one deploy's set of modules for a month.
    """
    digest = hashlib.sha256()
    try:
        for path in sorted(_GAME.glob("*.js")):
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
    except OSError:
        return "0"
    return digest.hexdigest()[:12]


_ASSET_VERSION = _asset_version()
_GAME_VERSION = _game_version()


@app.context_processor
def _template_globals() -> dict[str, object]:
    return {
        "site_origin": SITE_ORIGIN,
        "asset_version": _ASSET_VERSION if _IS_PROD else _asset_version(),
        "game_version": _GAME_VERSION if _IS_PROD else _game_version(),
        "current_year": date.today().year,
    }


@app.get("/")
def index() -> str:
    return render_template(
        "index.html",
        canonical_url=f"{SITE_ORIGIN}/",
    )


@app.get("/favicon.ico")
def favicon() -> Response:
    return send_from_directory(
        app.static_folder or "static", "zacwalk-portrait.svg", mimetype="image/svg+xml"
    )


@app.get("/game/<version>/<name>")
def game_script(version: str, name: str) -> Response:
    """The game's modules, under the version token of the deploy they belong to.

    Only the current token is served, so modules from two deploys can never meet in one
    page: a tab opened before a deploy gets a 404 for its old token until it reloads. The files
    under a token never change, so production lets browsers keep them for a month. The MIME
    type is set here because module scripts need a JavaScript one, and Windows can map .js to
    text/plain.
    """
    current = _GAME_VERSION if _IS_PROD else _game_version()
    if version != current or not name.endswith(".js"):
        abort(404)
    response = send_from_directory(_GAME, name, mimetype="text/javascript")
    response.headers["Cache-Control"] = (
        "public, max-age=2592000, immutable" if _IS_PROD else "no-cache"
    )
    return response


@app.errorhandler(404)
def not_found(_error: Exception) -> tuple[str, int]:
    return (
        render_template(
            "error.html",
            code="404",
            title="Page not found",
            message="That page has been refactored out of existence.",
        ),
        404,
    )


@app.errorhandler(500)
def server_error(_error: Exception) -> tuple[str, int]:
    return (
        render_template(
            "error.html",
            code="500",
            title="Something broke",
            message="Works on my machine. Try again in a moment.",
        ),
        500,
    )


@app.get("/health")
def health() -> tuple[str, int]:
    return "ok", 200


@app.get("/about")
def about() -> ResponseReturnValue:
    """The CV used to be its own page; it is now the home page's #about section."""
    return redirect("/#about", code=301)


@app.get("/robots.txt")
def robots_txt() -> Response:
    body = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /health\n"
        f"Sitemap: {SITE_ORIGIN}/sitemap.xml\n"
    )
    return Response(body, mimetype="text/plain")


@app.get("/sitemap.xml")
def sitemap_xml() -> Response:
    today = date.today().isoformat()
    pages = [
        {
            "loc": f"{SITE_ORIGIN}/",
            "lastmod": today,
            "changefreq": "weekly",
            "priority": "1.0",
        },
    ]
    xml = render_template("sitemap.xml", pages=pages)
    return Response(xml, mimetype="application/xml")


if __name__ == "__main__":
    # Local dev only; production uses gunicorn via app.yaml entrypoint.
    app.run(port=8081, host="localhost", debug=True)
