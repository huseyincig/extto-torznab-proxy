# EXT Torznab Proxy

EXT Torznab Proxy is a self-hosted Generic Torznab gateway for EXT-style torrent search pages.

It is designed for Prowlarr and uses FlareSolverr internally for Cloudflare/session handling. Users do not need to copy custom Prowlarr definition YAML files. Add it to Prowlarr as a Generic Torznab indexer.

## Features

- Generic Torznab API for Prowlarr
- FlareSolverr session handling
- Internal warm timer
- Search result cache
- Magnet cache
- Direct magnet resolving from torrent detail pages
- Web configuration page
- Turkish/English UI based on browser language
- Support for alternate base domains:
  - https://extranet.torrentbay.st
  - https://ext.to

## Docker Compose Example

services:
  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    environment:
      - TZ=Europe/Istanbul
    shm_size: "1gb"
    restart: unless-stopped

  extto-torznab-proxy:
    image: extto-torznab-proxy:latest
    container_name: extto-torznab-proxy
    depends_on:
      - flaresolverr
    environment:
      - TZ=Europe/Istanbul
      - PORT=8998
      - CONFIG_DIR=/config
    ports:
      - "8998:8998"
    volumes:
      - ./config:/config
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

## Web UI

Open:

http://YOUR_HOST_IP:8998/

Configure:

- Base URL
- Public URL
- FlareSolverr URL
- API key
- warm interval
- cache TTLs
- session options

## Prowlarr Setup

In Prowlarr:

Add Indexer -> Generic Torznab

Use:

URL: http://YOUR_HOST_IP:8998
API Path: /api
API Key: shown on the web UI
Redirect: disabled
Tags: optional, for example extto

Do not assign a FlareSolverr indexer proxy tag to this Generic Torznab indexer. This container handles FlareSolverr itself.

## Important Endpoints

/                 Web UI
/health           Health JSON
/warm             Manual warm
/cache/clear      Clear search and magnet cache
/session/reset    Reset FlareSolverr session
/api?t=caps       Torznab capabilities
/api?t=search     Torznab search
/download         Magnet redirect endpoint

## Notes

- Warm keeps the Cloudflare session active.
- Search cache and magnet cache are separate.
- Magnet resolving is done only when a result is downloaded, unless prefetch is enabled.
- If you change Base URL, it is recommended to clear cache, reset session, and run warm again.
