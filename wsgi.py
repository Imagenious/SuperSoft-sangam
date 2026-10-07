"""
WSGI entry point for hosting SuperSoft online (e.g. PythonAnywhere).

In the PythonAnywhere "WSGI configuration file" put:

    import sys
    sys.path.insert(0, "/home/<your-username>/SuperSoft-sangam")
    from wsgi import application
"""
import server

application = server.wsgi_app
