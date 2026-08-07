# Updating

Your figures live in the browser, not in these files, so replacing the files
never touches your data. Nothing you have typed is at risk.

## From a new zip

```bash
cd ~/dev/tax/build
unzip -o ~/Downloads/aotc-app.zip -d .
```

`-o` overwrites the app files and leaves everything else alone — including the
`.git` directory, so your published repo and its history survive.

## Push it live

```bash
cd ~/dev/tax/build/aotc-app
bash deploy.sh "read 1098-T PDFs"
```

GitHub Pages rebuilds in a minute or two.

## Check which version you are actually running

The version is printed at the bottom of the app. Compare it with `VERSION` in
`engine.js`. If the page shows an older number, the service worker is serving
you a cached copy:

- **Desktop:** hard reload — <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>.
- **Installed on a phone:** close the app fully and reopen it. It fetches from
  the network first, so one online launch is enough.

The cache is keyed to the version string, so a bumped version discards the old
files rather than serving them forever. That is the usual way an installed web
app appears not to update, and it is worth knowing about before it happens.
