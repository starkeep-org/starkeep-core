---
"@starkeep/app-client": patch
---

`createDataProxyHandler` refuses a request whose `Sec-Fetch-Site` is `cross-site` or `same-site` with 403, before any session check or credential load. A `GET` or `HEAD` navigation from another site still passes, because following a link writes nothing. On the local surface a page on another site could otherwise send the proxy a blind `no-cors` POST and have it signed. A request without the header, from a server, a script or a phone, passes as before.
