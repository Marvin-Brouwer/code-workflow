---
key: PROJ-7
summary: Login fails on Safari
url: https://example.atlassian.net/browse/PROJ-7
type: Story
status: To Do
priority: High
assignee: null
reporter: Rita Reporter
labels:
  - web
  - safari
components:
  - web
parent: null
created: "2026-11-10T09:00:00.000Z"
updated: "2026-11-11T09:00:00.000Z"
links:
  - relation: is blocked by
    key: PROJ-3
    summary: Session API
    status: Done
subtasks: []
attachments:
  - filename: login page.png
    mimeType: image/png
    file: PROJ-7/10001-login_page.png
  - filename: trace.har
    mimeType: application/json
    url: https://example.atlassian.net/secure/attachment/10002/trace.har
---

# PROJ-7: Login fails on Safari

## Description

## Steps

1.  Open the **login** page in Safari.
2.  Sign in with `user@example.com`.

See ![login page](PROJ-7/10001-login_page.png)

## Expected

The dashboard opens, as described in [the guidelines](https://example.atlassian.net/wiki/spaces/TEAM/pages/12345).

```
POST /session 200
```

<table><tbody><tr><th>Browser</th><th>Result</th></tr><tr><td>Safari 19</td><td>fails</td></tr><tr><td>Firefox</td><td>works</td></tr></tbody></table>

Ask `@mention({ name: "Rita Reporter", email: "rita@example.com", id: "5b10" })` for a test account.

## Comments

### Rita Reporter, 2026-11-10T10:00:00.000Z

Also on _iOS_.

### Dev Eloper, 2026-11-11T08:30:00.000Z

`@mention({ name: "Rita Reporter", email: "rita@example.com", id: "5b10" })` can you share the HAR file?

