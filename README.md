# SuperSoft — Cloth Business ERP

An offline billing and stock system for one shop PC. It is written in Python using only the standard library, so nothing extra needs installing.

## Start
Double-click **`Start SuperSoft.bat`**. The browser opens at http://127.0.0.1:8765.
Keep the black window open while you work, and close it to stop the software.

## Logins
- The first time SuperSoft starts on the PC, it asks you to **create the owner login**. The owner sees everything.
- Add staff logins under **Settings → Users & logins**. Staff can do billing, returns, customers, the stock list and labels. They never see cost, profit, cash in hand, expenses or reports.
- You can also let a staff member do stock inward; they will then see cost prices on those screens.
- Forgot the password? Run `python manage.py reset-password` in the SuperSoft folder.

## Online (PythonAnywhere)
See **[DEPLOY.md](DEPLOY.md)** for step-by-step instructions.

## Daily workflow
1. **Stock Inward (F3)**: choose the supplier, then category → sub-category. Enter quantity and cost for each size and set the markup %. The MRP is calculated automatically. Saving creates the barcodes.
2. **Barcode Labels**: print the labels for that inward on the thermal printer, with margins set to *None* and scale at *100%*.
3. **Sales / Billing (F2)**: enter the customer's mobile number (name and city fill in automatically for returning customers). Scan the items, or press **F4** to pick them from the dropdown lists. Enter only the **cash received**; the balance goes automatically to UPI, Card or Cheque. **F9** saves the bill and opens a print preview. Every bill includes 5% GST (change this in Settings). Profit is for internal use only: it's hidden by default and never appears on the bill.
   - **Stock inward correction**: go to Inward History, click ✎ Edit, correct the numbers and save. Stock adjusts automatically.
   - **Customers**: every customer's name, mobile and city are saved. See the Customers page, or Reports → Customer data.
   - **Expenses & Cash**: record every expense (rent, salary, tea and so on) and how it was paid. Record non-expense cash movements (bank deposit, owner withdrawal, cash supplier payment, cash added) under Cash In / Out. The dashboard's **Cash in Hand** = opening cash + cash sales − cash expenses + cash added − cash taken out. Set the opening cash once under Settings → Cash in hand.
4. **Return / Exchange**: on the Sales screen, enter the old bill number and the quantity being returned, then scan the new items. The customer pays or receives only the difference.
5. **Dashboard**: shows today's and this month's sales and profit, stock value, low-stock (MOQ) alerts and the best-selling items.
6. **Reports**: 19 reports covering sales, purchases, GST and stock. Each one can be exported to Excel as CSV or printed.

## Adding more later
Under **Masters** you can add categories, sub-categories (with HSN, GST, unit, size set and MOQ), size sets, brands and suppliers. Shop details, GST slabs, MRP rounding, label size and bill numbering are all under **Settings**.

## Data and backup
All data is stored in `data\sangam.db`. A backup is saved automatically to `data\backups\` every day when the software starts, and the last 60 backups are kept. To move to a new PC, copy the whole folder.
