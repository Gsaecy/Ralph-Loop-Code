const path = require('path');

async function main() {
  // sharp is a devDependency; used to render SVG -> PNG for VSCE icon.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp');

  const svgPath = path.join(__dirname, '..', 'media', 'icon.svg');
  const pngPath = path.join(__dirname, '..', 'media', 'icon.png');

  await sharp(svgPath, { density: 384 })
    .resize(256, 256, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toFile(pngPath);

  process.stdout.write(`Generated: ${pngPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
