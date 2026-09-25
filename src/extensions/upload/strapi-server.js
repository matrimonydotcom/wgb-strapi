'use strict';

// Override Strapi's default Sharp pipeline so generated thumbnail + responsive
// variants are encoded at quality 100. The upstream service (image-manipulation)
// calls sharp().resize(...) without setting an output format, so Sharp falls
// back to its defaults (JPEG/WebP quality 80). For CDN-fronted assets the
// bandwidth cost is paid once on upload — keep originals crisp.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { file: { bytesToKbytes } } = require('@strapi/utils');

const OUTPUT_QUALITY = 100;
const THUMBNAIL_RESIZE_OPTIONS = { width: 245, height: 156, fit: 'inside' };
const DEFAULT_BREAKPOINTS = { large: 1000, medium: 750, small: 500 };

function writeStreamToFile(stream, dest) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    stream.on('error', reject);
    stream.pipe(ws);
    ws.on('close', () => resolve());
    ws.on('error', reject);
  });
}

function applyFormat(transformer, format) {
  switch (format) {
    case 'jpeg':
    case 'jpg':
      return transformer.jpeg({ quality: OUTPUT_QUALITY, mozjpeg: true });
    case 'webp':
      return transformer.webp({ quality: OUTPUT_QUALITY });
    case 'avif':
      return transformer.avif({ quality: OUTPUT_QUALITY });
    case 'tiff':
      return transformer.tiff({ quality: OUTPUT_QUALITY });
    case 'png':
      return transformer.png({ compressionLevel: 9 });
    default:
      return transformer;
  }
}

async function readMetadata(file) {
  if (file.filepath) return sharp(file.filepath).metadata();
  return new Promise((resolve, reject) => {
    const pipeline = sharp();
    pipeline.metadata().then(resolve).catch(reject);
    file.getStream().pipe(pipeline);
  });
}

async function resizeAtHighQuality(file, options, { name, hash }) {
  const filePath = file.tmpWorkingDirectory
    ? path.join(file.tmpWorkingDirectory, hash)
    : hash;
  const { format } = await readMetadata(file);

  let newInfo;
  if (!file.filepath) {
    const transform = applyFormat(sharp().resize(options), format).on(
      'info',
      (info) => { newInfo = info; }
    );
    await writeStreamToFile(file.getStream().pipe(transform), filePath);
  } else {
    const transform = applyFormat(sharp(file.filepath).resize(options), format);
    newInfo = await transform.toFile(filePath);
  }

  const { width, height, size } = newInfo ?? {};
  return Object.assign(
    {
      name,
      hash,
      ext: file.ext,
      mime: file.mime,
      filepath: filePath,
      path: file.path || null,
      getStream: () => fs.createReadStream(filePath),
    },
    {
      width,
      height,
      size: size ? bytesToKbytes(size) : 0,
      sizeInBytes: size,
    }
  );
}

module.exports = (plugin) => {
  const service = plugin.services['image-manipulation'];
  if (!service) return plugin;

  service.generateThumbnail = async (file) => {
    if (
      file.width &&
      file.height &&
      (file.width > THUMBNAIL_RESIZE_OPTIONS.width ||
        file.height > THUMBNAIL_RESIZE_OPTIONS.height)
    ) {
      return resizeAtHighQuality(file, THUMBNAIL_RESIZE_OPTIONS, {
        name: `thumbnail_${file.name}`,
        hash: `thumbnail_${file.hash}`,
      });
    }
    return null;
  };

  service.generateResponsiveFormats = async (file) => {
    const settings =
      (await strapi.plugin('upload').service('upload').getSettings()) ?? {};
    if (!settings.responsiveDimensions) return [];

    const { width = 0, height = 0 } = await readMetadata(file);
    const breakpoints = strapi.config.get(
      'plugin::upload.breakpoints',
      DEFAULT_BREAKPOINTS
    );

    return Promise.all(
      Object.keys(breakpoints).map(async (key) => {
        const breakpoint = breakpoints[key];
        if (breakpoint < (width ?? 0) || breakpoint < (height ?? 0)) {
          const newFile = await resizeAtHighQuality(
            file,
            { width: breakpoint, height: breakpoint, fit: 'inside' },
            { name: `${key}_${file.name}`, hash: `${key}_${file.hash}` }
          );
          return { key, file: newFile };
        }
        return undefined;
      })
    );
  };

  return plugin;
};
