# Deployment Guide — SAR MOT KPI Data Sharing POC

This document records the tooling, environment setup, and deployment procedures for the SAR MOT KPI solution.

## Tooling & Prerequisites

### 1. Application Integration Management Toolkit (`integrationcli`)
- **Binary:** `integrationcli`
- **Installed Version:** `integrationcli version 0.86.0 date: 2026-03-13T18:03:59Z [commit: d6fa527]`
- **Repository:** `https://github.com/GoogleCloudPlatform/application-integration-management-toolkit`
- **Installation Path:** `C:\Users\ENVNT.DESKTOP-125116U\tools\integrationcli` (available on system PATH)

### 2. Node.js & Apigee Linting Tools
- **Node.js:** `v24.20.0`
- **npm:** `11.19.0`
- **apigeelint:** `2.85.1` (pinned in `package.json`)
- **newman:** `6.2.3` (pinned in `package.json`)
- **mocha / chai:** unit testing framework for proxy JavaScript policies

### 3. Build & Deployment
- **Maven:** `3.9.9` with `io.apigee.build-tools.enterprise4g:apigee-edge-maven-plugin:2.5.2`
- **Google Cloud SDK:** `583.0.0`

## Apigee environment settings

### Debug masks (AGENTS.md rule 4)

- Source of truth: `src/main/apigee/environments/<env>/debugmask.json` (local, dev, staging, prod).
- Applied with:
  `PATCH https://apigee.googleapis.com/v1/organizations/<org>/environments/<env>/debugmask?updateMask=variables`
  with the body `{"variables": [...]}` taken from that file.
- Dev was applied by hand this way in P5 and verified in a debug session (D40). Staging and prod
  are not masked yet: the P7 pipeline must run exactly this call for every environment before
  deploying the proxy.

### Debug sessions via REST

- The create `POST .../debugsessions` needs `Content-Length: 0` (otherwise HTML 411).
- Data appears about 15 s or more after the session is created; `GET .../debugsessions/{id}/data`
  lists the transaction ids (D35).
