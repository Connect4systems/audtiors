import frappe


def disable_employee_checkin_client_script():
    """Disable any Client Script records that target the `Employee Checkin` doctype.

    This prevents UI Client Scripts from overriding the app-provided script.
    """
    # Try common field names for Client Script reference across Frappe versions
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
            frappe.log("Disabled Client Script: {}".format(name))
        except Exception:
            frappe.log_error(f"Failed to disable Client Script {name}")

    return
