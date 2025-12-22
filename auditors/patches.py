import frappe


def disable_employee_checkin_client_script():
    """Disable any Client Script records that target the `Employee Checkin` doctype.

    This wrapper ensures `auditors.patches.disable_employee_checkin_client_script` is importable
    during migrations. It delegates to the implementation under auditors.auditors.patches
    when available, otherwise runs a local implementation.
    """
    try:
        # prefer the deeper module if present
        from auditors.auditors.patches import disable_employee_checkin_client_script as _impl
        return _impl()
    except Exception:
        # fallback local implementation without reload_doc to avoid module path errors
        filters = [
            ['Client Script', 'dt', '=', 'Employee Checkin'],
            ['Client Script', 'ref_doctype', '=', 'Employee Checkin'],
            ['Client Script', 'reference_doctype', '=', 'Employee Checkin'],
        ]

        found = set()
        for f in filters:
            try:
                scripts = frappe.get_all('Client Script', filters={f[1]: f[2]}, fields=['name', 'disabled'])
            except Exception:
                scripts = []
            for s in scripts:
                found.add(s['name'])

        for name in found:
            try:
                frappe.db.set_value('Client Script', name, 'disabled', 1)
                frappe.db.commit()
            except Exception:
                frappe.log_error(f"Failed to disable Client Script {name}")

        return
