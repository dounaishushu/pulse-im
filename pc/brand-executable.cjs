// Edit the app's Windows PE resources locally. The stock signing-tool bundle
// also contains macOS symlinks and cannot unpack on some Windows installations.
// This hook keeps icon/version editing independent of certificate provisioning.
const fs = require('node:fs');
const path = require('node:path');
const ResEdit = require('resedit');

module.exports = async function brandExecutable(context) {
  if (context.electronPlatformName !== 'win32') return;
  const metadata = require('./package.json');
  const filename = metadata.build.productName + '.exe';
  const target = path.join(context.appOutDir, filename);
  const executable = ResEdit.NtExecutable.from(fs.readFileSync(target), { ignoreCert: true });
  const resource = ResEdit.NtExecutableResource.from(executable);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'assets/app-icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries);
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resource.entries, group.id, group.lang, icon.icons.map(frame => frame.data));
  }
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resource.entries);
  const info = versions[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const languages = info.getAllLanguagesForStringValues();
  for (const language of languages.length ? languages : [{ lang: 1033, codepage: 1200 }]) {
    info.setStringValues(language, { ProductName: metadata.build.productName, FileDescription: metadata.description, InternalName: metadata.build.productName, OriginalFilename: filename });
    info.setFileVersion(metadata.version, language.lang);
    info.setProductVersion(metadata.version, language.lang);
  }
  info.outputToResourceEntries(resource.entries);
  resource.outputResource(executable);
  fs.writeFileSync(target, Buffer.from(executable.generate()));
  console.log('已写入小猿口算程序图标、产品名称和版本资源。');
};
