# Remote Desk - Desktop Tracking Agent

This is the background employee activity monitoring client agent for Remote Desk. It runs silently in the system tray, capturing active window details, mouse/keyboard events, and uploading metrics to the backend. It is built with Electron, React, and TypeScript.

---

## Prerequisites
* Node.js (v20.x or higher)
* npm (v10.x or higher)

---

## Setup and Installation

### 1. Install Dependencies
Run the installation with the `--ignore-scripts` flag to prevent local compilation issues of native modules (`better-sqlite3` and `keytar`) on systems without native C++ compiler tools:
```bash
npm install --ignore-scripts
```

### Development Fallbacks
To support development on machines without C++/Python tools installed, the agent implements automatic fallback logic:
* **Token Caching Fallback:** If `keytar` native modules fail to load, the credentials cache falls back to local user-data folder JSON serialization.
* **Offline Buffer Fallback:** If the `better-sqlite3` native database engine fails to load, offline tracking logs are stored in a local JSON buffer, syncing automatically once the backend API comes online.
* **Shell Window Tracker:** Bypasses heavy native hooks by capturing active windows using native shell command executors (PowerShell for Windows, AppleScript for macOS, and xdotool for Linux).

---

## Running the Application

### Development Mode
To launch the desktop app locally for testing:
```bash
npm run dev
```

### Compile and Build Installers
To build and package installers manually:
```bash
# Transpile TypeScript source files
npm run build:renderer

# Build target installer packages (.exe, .dmg, .AppImage)
npm run dist
```
Distribution installer packages will be written to `release/`.

---

## GitHub Release Pipelines

The repository includes two manual workflows located in `.github/workflows/` to handle releases:

### 1. Create Release Tag (`release.yml`)
* Run this workflow manually in your GitHub repository, choosing the bump type (`patch`, `minor`, `major`).
* It computes the next version, tags the commit, pushes it, and creates a draft GitHub Release page.

### 2. Build and Package Installers (`build.yml`)
* Run this workflow manually in your GitHub repository, entering the version tag created in the previous step (e.g. `v1.0.1`).
* It runs a cross-platform matrix, compiles the code on Windows, macOS, and Linux runners, and attaches the compiled installers to the release page.
