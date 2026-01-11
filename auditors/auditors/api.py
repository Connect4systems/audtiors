import frappe
from frappe import _
from math import radians, cos, sin, asin, sqrt


def before_validate_employee_checkin(doc, method=None):
    """Override Employee Checkin validation to bypass location check when reason is provided."""
    # If a reason is provided, we'll skip location validation
    if doc.reason and doc.reason.strip():
        # Store the original validate method
        if not hasattr(doc, '_original_validate_method'):
            doc._original_validate_method = doc.validate
        
        # Create a custom validate method that skips location checks
        def custom_validate():
            # Call original validate but catch location-related errors
            try:
                # Temporarily disable location validation by monkey-patching
                original_validate_attendance_location = None
                if hasattr(doc, 'validate_attendance_location'):
                    original_validate_attendance_location = doc.validate_attendance_location
                    doc.validate_attendance_location = lambda: None
                
                # Call original validation
                if hasattr(doc, '_original_validate_method'):
                    doc._original_validate_method()
                
                # Restore original method
                if original_validate_attendance_location:
                    doc.validate_attendance_location = original_validate_attendance_location
                    
            except Exception as e:
                error_msg = str(e)
                # If error is about location/distance, suppress it when reason is provided
                if any(keyword in error_msg.lower() for keyword in ['within', 'meters', 'location', 'distance']):
                    if doc.reason and doc.reason.strip():
                        # Suppress location-related errors when reason is provided
                        pass
                    else:
                        raise
                else:
                    # Re-raise non-location errors
                    raise
        
        # Replace validate method
        doc.validate = custom_validate


def validate_employee_checkin(doc, method=None):
    """Custom validation for Employee Checkin to bypass location check when reason is provided."""
    # If a reason is provided, skip the standard location validation
    if doc.reason and doc.reason.strip():
        # Mark that custom validation passed so standard checks are bypassed
        doc.flags.ignore_validate = True
        doc.flags.skip_location_validation = True
        
        # Manually set the skip_auto_attendance flag if needed
        if not hasattr(doc, 'skip_auto_attendance'):
            doc.skip_auto_attendance = 0
            
        # Override the validate_attendance_location method temporarily
        # by marking this checkin as already validated
        doc._location_validated = True
        return
    
    # Otherwise, let standard validation proceed
    return


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
