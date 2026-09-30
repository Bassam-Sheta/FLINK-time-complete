# FLINK Time & Workforce Platform

Google Workspace-native time tracking and workforce management. This edition uses server-observed Google identity plus mandatory app MFA; FLINK does not ask for or store Google passwords.

**Validation status:** source and local automated tests have been checked. The provided staging project currently has no deployment; installation, OAuth consent, Sheets/Drive operations, real account isolation, and scheduled triggers remain untested in Google. See [release verification and remaining work](docs/RELEASE_VERIFICATION.md).

## Install FLINK Time

### Recommended: Automated Installer

Normal installers do **not** need GitHub, npm, Node.js, Git, PowerShell, source-file copying, a setup key, or the Apps Script deployment screens.

The separate application under `installer/` automates the deployment work:

1. Open your organization's **FLINK Time Installer**.
2. Open Google's Apps Script settings and enable **Google Apps Script API** access once.
3. Return to the installer and click **INSTALL FLINK TIME**.
4. The installer creates the Master Sheet, creates the bound Apps Script project, uploads the five production files, creates a version, creates the Web App deployment, and opens the Super Admin URL.
5. If the newly created FLINK Time project still needs its own Drive/Sheets consent, its first-run page shows **AUTHORIZE FLINK TIME** using Google's authorization URL.
6. Complete the guided Super Admin setup.

Google's API-access toggle and OAuth consent are deliberate Google security approvals. The installer automates the deployment operations around them; it does not bypass those approvals.

See **[docs/INSTALLATION.md](docs/INSTALLATION.md)** for the full installer flow and manual fallback.

## Production application

The installed FLINK Time runtime is still only:

```
apps-script/
  Code.gs
  User.html
  Admin.html
  SuperAdmin.html
  appsscript.json
```

The separate `installer/` project is only a distribution tool. Its script-management scopes are **not** added to the five-file FLINK Time runtime.

Portal rule:

- **Employee:** may be embedded in Google Sites.
- **Admin:** direct Web App access.
- **Super Admin:** direct Web App access.

## Repository folders

```
src/backend/       ordered editable backend modules
src/portals/       shared GUI template and role-specific fragments
scripts/build.cjs  deterministic five-file build
vendor/            pinned cryptographic library and license
apps-script/       generated five-file deployment application
installer/         separate automated deployment application
tests/             automated regression/security/browser tests
docs/              installation, architecture, and security documentation
.github/workflows  GitHub CI
```

npm, Node.js, Playwright, and GitHub Actions are development/CI tools only.

## Developers

```bash
npm ci --ignore-scripts
npm run build
npm test
npx playwright install chromium
npx playwright test --project=chromium
```

Edit `src/` and rebuild; do not edit generated `apps-script/Code.gs` or portal HTML directly. `npm test` rejects stale generated files. Authentication passwords are managed in Google Account; Super Admin security recovery provides FLINK session revocation and authenticator reset. Root MFA recovery is owner-controlled and is not exposed in generic web CRUD.

GitHub Actions runs regression/security tests, browser acceptance, and real portal screenshot capture for pull requests and `main`.

Architecture and security details are in **[docs/SYSTEM_SPEC.md](docs/SYSTEM_SPEC.md)**.
