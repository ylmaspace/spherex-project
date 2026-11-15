# SPHEREx IRSA/Aladin implementation notes

This iteration adds progressive discovery of the official QR2 Level 2 IBE directory and on-demand FITS streaming. It does not recursively crawl or mirror the archive. The catalog only returns links found in the live directory response; filename-derived fields are labeled as path organization, not FITS metadata. RA/Dec/WCS cannot be inferred from an IBE directory listing and therefore are not fabricated.

## Current supported flow

1. Open the **OBSERVACIONES IRSA** catalog in the Explorer.
2. Browse one directory at a time; select a listed period directory to descend.
3. Filter the current listing by filename/path, and paginate the FITS files.
4. Open an IRSA-listed FITS file through the same-origin `/api/fits` stream, or choose a local FITS file.
5. The FITS image is rendered by Aladin Lite v3. Split view/Blink can compare selected FITS files when both products are readable by Aladin.

Directory listings are cached in-process for five minutes. This is intentionally a small cache suitable for Render Free; use managed Redis or a durable index if multi-instance/global search is later required. The IBE proxy accepts only FITS paths under the fixed official IRSA Level 2 root and supports a single byte Range request.

## Scientific limits

- The public QR2 Level 2 tree is not a HiPS service. No all-sky HiPS mosaic is claimed or generated.
- Directories do not guarantee spatial/temporal metadata. To support RA/Dec coverage search, FITS header/WCS indexing or an authoritative SPHEREx ObsCore table is still needed. Do not treat listing filenames as observation metadata.
- FITS local handling currently delegates to Aladin Lite. Full HDU enumeration, pixel-value inspection, image stretch/colormap controls, and robust WCS registration need a dedicated FITS client and validation against representative SPHEREx MEF products.
- Aladin Lite displays the base DSS2 atlas in Globe mode. QR2 Level 2 FITS files are loaded as image products; they are not misrepresented as a ready-made HiPS layer.
- The IRSA directory endpoint/network could not be exercised from this coding environment. The automated tests cover listing parsing, safe-path handling, filters, and pagination; perform the deployment smoke test below.

## Render smoke test (manual, no automatic deployment)

After reviewing and merging the branch, deploy the existing Render Blueprint manually. Configure `DATABASE_URL` with the existing PostgreSQL database URL; do not create another database. Then verify:

- `GET /api/health`
- `GET /api/catalog?page=1&page_size=20`
- Open a directory returned by `directories[]` using its `path` in `/api/catalog?path=...`
- Select a returned FITS `path` and verify `GET /api/fits?path=...` returns FITS bytes (and Range requests return 206 when supported upstream)
- Test local FITS selection and Aladin Lite display in a browser using representative QR2 files.

Deployment is not performed by this change.
