import { callbackUri, parseCallback } from './protocol';

// Execute inline before any rendering or external resource loading.
const query = location.search;
const fragment = location.hash;
history.replaceState(null, '', location.pathname);

document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('status')!;
  const actions = document.getElementById('actions')!;
  if (!query && !fragment) return;
  try {
    if (fragment) throw new Error('Unexpected callback fragment.');
    const response = parseCallback(new URLSearchParams(query));
    const uri = callbackUri(response);
    status.textContent = response.error ? 'Sign-in was declined or could not be completed. Return to Obsidian to continue.' : 'Return to Obsidian to finish connecting Google. The plugin will show your connection and sync status.';
    const open = document.createElement('a');
    open.textContent = 'Return to Obsidian'; open.href = uri; open.className = 'button';
    actions.append(open);
    const copy = document.createElement('button');
    copy.textContent = 'Copy return link'; copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(uri);
        status.textContent = 'Return link copied. In Obsidian, run “Drive Sync: Paste sign-in return link”. Do not share this link.';
      } catch { status.textContent = 'Could not copy the link. Use “Return to Obsidian” or copy that link manually.'; }
    });
    actions.append(copy);
    // A tap is reliable across more iOS browsers than forced navigation.
    // The page holds no refresh tokens, client secrets, or PKCE verifier.
  } catch { status.textContent = 'This sign-in response is invalid. Return to Obsidian and start sign-in again.'; }
});
