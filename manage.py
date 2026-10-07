"""
SuperSoft admin commands (run in a console / PythonAnywhere Bash console):

    python manage.py create-owner        create the first owner login
    python manage.py reset-password      set a new password for any user
    python manage.py list-users          show all logins
    python manage.py backup              take a database backup now
"""
import getpass
import sys

import server


def ask_password():
    while True:
        p1 = getpass.getpass("New password (min 8 characters): ")
        p2 = getpass.getpass("Repeat password: ")
        if p1 != p2:
            print("Passwords do not match, try again.")
        elif len(p1) < 8:
            print("Too short, try again.")
        else:
            return p1


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    server.ensure_db()
    db = server.DB
    if cmd == "create-owner":
        username = input("Owner username: ").strip()
        name = input("Full name (optional): ").strip()
        server.create_user(username, ask_password(), "OWNER", name)
        db.commit()
        print(f"Owner '{username}' created. You can now log in.")
    elif cmd == "reset-password":
        username = input("Username: ").strip()
        u = server.row("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,))
        if not u:
            print("No such user.")
            return
        db.execute("UPDATE users SET pass_hash=?, active=1 WHERE id=?", (server.hash_password(ask_password()), u["id"]))
        db.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
        db.commit()
        print(f"Password for '{u['username']}' changed.")
    elif cmd == "list-users":
        for u in server.rows("SELECT username, name, role, can_inward, active FROM users ORDER BY role, username"):
            print(f"{u['username']:<20} {u['role']:<6} inward={'yes' if u['can_inward'] else 'no':<4} "
                  f"{'active' if u['active'] else 'DISABLED'}  {u['name']}")
    elif cmd == "backup":
        print("Backup saved:", server.backup("manual"))
    else:
        print(__doc__)


if __name__ == "__main__":
    try:
        main()
    except server.ApiError as e:
        print("Error:", e)
