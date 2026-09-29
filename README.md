<div align="center">

# QuickView

![quickView](./assets/icons/icon.png)

---

</div>

Hot reloading for PDF and markdown documents. QuickView is intended to be used along with the [qv command line tooling](https://github.com/Implycitt/tools/tree/main/qv). Instructions for downloading and using the tooling can be found in the linked repository. 

QuickView is to be used along with a text editor for creating or modifying documents that compile to PDF or markdown files. Primary use cases include github readmes or watching compiled LaTeX/Typst documents.

![Demo](./assets/quickView.gif)

## Prerequisites

* [bun](https://bun.com/) package manager.
  * Alternatively, you can use [npm](https://nodejs.org) or another package manager.

## Building locally

1. Clone the repo

```sh
git clone https://github.com/Implycitt/quickView.git

cd quickView
```

2. Install dependencies

```sh
bun install
```

3. Run QuickView

```sh
bun run dev
```

### Downloading Releases

Alternatively, you can use the project by downloading the latest [release](https://github.com/Implycitt/quickView/releases).

## Roadmap

- [ ] HTML support