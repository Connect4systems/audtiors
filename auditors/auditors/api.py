import frappe


@frappe.whitelist()
def get_attendance_grace():
    """Return late entry and early exit grace periods (minutes).

    Tries common single doctypes and falls back to defaults.
    """
    defaults = {
        'late_entry': 60,
        'early_exit': 5,
        'after_end_allow': 60
    }

    # Try common single doctypes/fields used in various setups
    try:
        late = frappe.db.get_single_value('HR Settings', 'late_entry_grace_period')
    except Exception:
        late = None

    try:
        early = frappe.db.get_single_value('HR Settings', 'early_exit_grace_period')
    except Exception:
        early = None

    # Some installations use Attendance Settings
    try:
        late2 = frappe.db.get_single_value('Attendance Settings', 'late_entry_grace_period')
    except Exception:
        late2 = None

    try:
        early2 = frappe.db.get_single_value('Attendance Settings', 'early_exit_grace_period')
    except Exception:
        early2 = None

    result = {
        'late_entry': int(late or late2 or defaults['late_entry']),
        'early_exit': int(early or early2 or defaults['early_exit']),
        'after_end_allow': int(defaults['after_end_allow'])
    }

    return result
