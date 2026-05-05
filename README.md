# Vault App

A secure vault application built with Electron.

## Features

- Secure storage for sensitive information
- Cross-platform desktop application (Windows, macOS, Linux)
- Local encryption for maximum privacy

## Tech Stack

- **Electron** - Desktop app framework
- **HTML/CSS/JavaScript** - Frontend
- **Node.js** - Backend logic

## Project Structure
├── src/
│ ├── main.js # Electron main process
│ └── package.json # Dependencies & scripts
├── app.css # Application styles
├── app.js # Renderer process logic
├── index.html # Main window UI
├── preload.js # Preload script for security
├── icon.ico # Windows app icon
└── icon.png # App icon (macOS/Linux)


## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- npm (comes with Node.js)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yassine808/vault-app.git
   cd vault-app

   npm install

   npm start

   npm run build

   test