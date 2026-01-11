import frappe
from frappe import _
from hrms.hr.doctype.employee_checkin.employee_checkin import EmployeeCheckin


class CustomEmployeeCheckin(EmployeeCheckin):
    """Custom Employee Checkin to bypass location validation when reason is provided."""
    
    def validate_attendance_location(self):
        """Override to skip location validation if a reason is provided."""
        # If a reason is provided, skip location validation
        if self.reason and self.reason.strip():
            return
        
        # Otherwise, call the parent validation
        super().validate_attendance_location()
