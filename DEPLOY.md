# Deploying SuperSoft on PythonAnywhere

These steps take you from this GitHub repository to a running SuperSoft at
`https://<your-username>.pythonanywhere.com`. Replace `<your-username>` with your PythonAnywhere username everywhere below.

> **Your shop data is never in GitHub.** The `data/` folder (bills, customers, profit, logins) is excluded by `.gitignore`.
> You upload it straight to PythonAnywhere in Step 4.

---

## Step 1 — Copy the code to PythonAnywhere
1. Log in to **pythonanywhere.com**, open the **Consoles** tab and click **Bash**.
2. Run:
   ```bash
   git clone https://github.com/Imagenious/SuperSoft-sangam.git
   ```
3. Check that it worked:
   ```bash
   ls SuperSoft-sangam
   ```
   You should see `server.py`, `wsgi.py`, `manage.py` and the `static` folder.

## Step 2 — Create the web app
1. Open the **Web** tab and click **Add a new web app**, then **Next**.
2. Choose **Manual configuration** (not Flask or Django).
3. Choose the newest **Python 3.x** offered (3.10 or newer), then **Next**.

## Step 3 — Point the web app at SuperSoft
1. On the **Web** tab, find **Code → WSGI configuration file** and click the link (`/var/www/<your-username>_pythonanywhere_com_wsgi.py`).
2. **Delete everything** in that file and paste this in:
   ```python
   import sys
   path = "/home/<your-username>/SuperSoft-sangam"
   if path not in sys.path:
       sys.path.insert(0, path)
   from wsgi import application
   ```
3. Click **Save**.

## Step 4 — Upload your shop data
1. On your shop PC, **close SuperSoft** (close the black window) so the data file isn't in use.
2. On the PC, the data file is `SuperSoft folder\data\sangam.db`.
3. On PythonAnywhere, open the **Files** tab and go to `/home/<your-username>/SuperSoft-sangam/`.
4. Create a new directory named **`data`** and open it.
5. Click **Upload a file** and choose `sangam.db`.

If you skip this step, SuperSoft starts with an empty database. That's fine for a fresh start.

## Step 5 — Logins
- If you already **created your owner login on the PC** before uploading the data, the same username and password work online.
- If not, go back to the **Bash** console and run:
  ```bash
  cd ~/SuperSoft-sangam
  python3 manage.py create-owner
  ```
  Then type a username and password (at least 8 characters).
- Staff logins are added later from inside SuperSoft, under **Settings → Users & logins**.

## Step 6 — Secure and start
1. On the **Web** tab, set **Force HTTPS** to **Enabled**.
2. Click the big green **Reload** button.
3. Open `https://<your-username>.pythonanywhere.com` and sign in.

## Step 7 — After going live
- **Use only the online version from now on.** If you also keep entering bills on the PC version, the two copies go out of step.
- **Free plan:** PythonAnywhere pauses free web apps after 3 months. Log in and click **"Run until 3 months from today"** on the Web tab before then.
- **Backups:** SuperSoft makes a daily backup in `data/backups/` on the server. Once a week, download the newest file from the **Files** tab to your PC.
- **Printing:** barcode labels and invoices print from the shop PC's browser, exactly as before.

## Updating SuperSoft later
When a new version is pushed to GitHub, open a **Bash** console and run:
```bash
cd ~/SuperSoft-sangam
git pull
```
Then click **Reload** on the Web tab. Your data stays where it is.

## Useful console commands
```bash
cd ~/SuperSoft-sangam
python3 manage.py list-users        # show all logins
python3 manage.py reset-password    # forgotten password
python3 manage.py backup            # backup now
```
