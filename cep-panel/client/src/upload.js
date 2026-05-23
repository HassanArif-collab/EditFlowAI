/**
 * upload.js — File picker + uploader for script attachments.
 *
 * Routes script-like files through POST /api/v2/scripts/extract.
 */
import { apiUpload } from './api.js';

/**
 * Upload a file to the script extraction endpoint.
 *
 * @param {File} file - The file to upload
 * @returns {Promise<object>} Extraction result: { success, filename, full_text, pages, page_count }
 */
async function uploadScript(file) {
  try {
    const result = await apiUpload('/api/v2/scripts/extract', file);
    return result;
  } catch (err) {
    throw new Error(`Script upload failed: ${err.message}`);
  }
}

/**
 * Open a native file picker for script files.
 *
 * @returns {Promise<File|null>} Selected file or null
 */
function pickScriptFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.txt,.md';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', () => {
      const file = input.files[0] || null;
      input.remove();
      resolve(file);
    });

    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });

    input.click();
  });
}

export { uploadScript, pickScriptFile };
