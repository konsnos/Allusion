<img alt="Allusion" src="./screenshot.jpg"/>

Fork of [RafaUC/Allusion](https://github.com/RafaUC/Allusion), itself a fork of [Allusion](https://github.com/allusion-app/Allusion/), with upgraded packages:
- Electron 21 → 45 (Chromium 156, Node.js 24).
- electron-builder 23 → 26 and electron-updater 5 → 6.
- better-sqlite3 9.6 → 13, with prebuilt binaries that no longer need rebuilding for each Electron version.
- TypeScript 4.9 → 5.9.
- Updated GitHub Actions workflows.

Allusion now runs on 64-bit Windows 10 or later, macOS 13 or later, and 64-bit Linux. On first start, it moves the library database from the `databases` folder to `allusion-db` in its data folder.

Adding a location is also much faster. Reading image dimensions takes about 1.3 ms per file instead of 29 ms, so a folder of 60,000 images (34.5 GB) loads in a couple of minutes instead of about half an hour.

Thumbnails appear sooner too. A screen of 81 large PNGs gets its thumbnails in about 20 seconds instead of 27, images scrolled out of view no longer hold up the ones on screen, and small images are no longer re-checked hundreds of times a second while they are visible.
        
Thanks to the developers and the community for your hard work! ❤️

---

Allusion is a tool built for artists, aimed to help you organize your **Visual Library** – A single place that contains your entire collection of references, inspiration and any other kinds of images.

[Read more about Allusion →](https://allusion-app.github.io/)

## Installation


Find the latest version of Allusion on the [Releases](https://github.com/konsnos/Allusion/releases) page.


## Development

### Quick Start

You need to have [NodeJS](https://nodejs.org/en/download/) 22.14 or later and a package manager such as [Yarn](https://yarnpkg.com/lang/en/docs/install/) installed.
Then run the following commands to get started:

1. Run `yarn install` to install or update all necessary dependencies.
2. Run `yarn dev` to build the project files to the `/build` directory. This will keep running to immediately build changed files when they are updated.
3. In a second terminal, run `yarn start` to start the application. Refresh the window (Ctrl/Cmd + R) after modifying a file to load the updated build files.

### Release Build

An installable executable can be built using `yarn package` for your platform in the `/dist` folder. The building is performed using the [electron-builder](https://www.electron.build/) package, and is configured by a section in the `package.json` file.

## Further Information

The original repo had a [wiki] with documentation (https://github.com/allusion-app/Allusion/wiki).
