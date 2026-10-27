# Folio

Folio turns document photos into clean, perspective-corrected, multi-page PDFs. Add photos from a device or camera, adjust detected corners, choose a finish, rearrange pages, and download a ready-to-share document.

## Use it

Open `index.html` in a modern browser, or visit [Folio on GitHub Pages](https://zenonym.github.io/pdf/) after the first deployment. Choose one or more photos and drag the four corners to crop the page right away. **Find edges** is optional if you want automatic detection; the first scan can take longer while OpenCV.js downloads and starts.

Folio works in the browser. Your images are processed locally and are not uploaded. The page finder uses OpenCV.js and PDF generation uses pdf-lib, loaded from their public CDNs when needed. An internet connection is required for those libraries on first use.

## Features

- Optional automatic page outline detection and perspective correction
- Manual four-corner adjustment with a live corrected preview
- Multi-page PDFs, with page ordering and removal controls
- Color, grayscale, and black-and-white finishes
- A4 output with landscape pages where appropriate
- Phone camera capture and drag-and-drop image import
- Local processing; no account or file upload

## Browser support

Use a current version of Chrome, Edge, Firefox, or Safari. HEIC support depends on the browser and operating system; convert the photo to JPEG or PNG if it cannot be opened.

## GitHub Pages

The included workflow publishes each push to `main`. If Pages is not enabled yet, set the source to **GitHub Actions** under repository **Settings → Pages**. The site will appear at `https://zenonym.github.io/pdf/` after the first successful deployment.
