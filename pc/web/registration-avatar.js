/* A registration image stays local until the account form is submitted. */
(() => {
  const maximumFileBytes = 10 * 1024 * 1024;
  async function prepare(file, { signal } = {}) {
    if (!file || !Number.isFinite(file.size) || file.size <= 0) throw new Error('请选择一张头像图片');
    if (file.size > maximumFileBytes) throw new Error('头像图片不能超过 10MB，请选择较小的图片');
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    signal?.throwIfAborted();
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value);
    const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!jpeg && !png && !webp) throw new Error('请选择 JPG、PNG 或 WebP 图片');
    const image = new Image();
    const objectURL = URL.createObjectURL(file);
    let timeout, abort;
    try {
      image.src = objectURL;
      await Promise.race([
        image.decode(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('头像读取超时，请重新选择')), 15000); }),
        new Promise((_, reject) => {
          abort = () => reject(new DOMException('Avatar preparation cancelled', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
      signal?.throwIfAborted();
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height || width * height > 40_000_000) throw new Error('头像分辨率过大或图片无效，请选择其他图片');
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('头像暂时无法处理，请重新选择');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, 512, 512);
      const side = Math.min(width, height);
      context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 512, 512);
      const result = canvas.toDataURL('image/jpeg', 0.85);
      if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(result) || result.length > 1_398_125) throw new Error('头像处理失败，请重新选择图片');
      return result;
    } catch (error) {
      if (error.name === 'AbortError' || /头像/.test(error.message || '') || /请选择/.test(error.message || '')) throw error;
      throw new Error('图片无法读取，请选择有效的 JPG、PNG 或 WebP 图片');
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      image.src = ''; URL.revokeObjectURL(objectURL);
    }
  }
  window.PulseRegistrationAvatar = Object.freeze({ prepare });
})();
