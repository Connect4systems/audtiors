frappe.ui.form.on('Employee Checkin', {
    refresh: function(frm) {
        set_log_type_and_alert(frm);
    },
    before_save: function(frm) {
        // If we have already passed custom validation, let save continue
        if (frm._skip_validation) {
            frm._skip_validation = false;
            frappe.validated = true;
            return;
        }

        // Always block the default save so we can validate asynchronously
        frappe.validated = false;

        // Ensure coordinates then validate timing windows
        ensure_coordinates_then_validate(frm);
    },
    // keep other handlers
    time: function(frm) {
        set_log_type_and_alert(frm);
    },
    employee: function(frm) {
        set_log_type_and_alert(frm);
    },
    shift_start: function(frm) {
        set_log_type_and_alert(frm);
    },
    shift_end: function(frm) {
        set_log_type_and_alert(frm);
    }
});

function set_log_type_and_alert(frm) {
    try {
        // use the doc time if set, otherwise current datetime
        let time_val = frm.doc.time || (frappe.datetime && frappe.datetime.now_datetime && frappe.datetime.now_datetime());
        let checkMoment = time_val ? moment(time_val) : moment();
        if (!checkMoment.isValid()) checkMoment = moment();

        // Prefer shift_start/shift_end fields already present on the checkin doc
        let shiftStartStr = frm.doc.shift_start;
        let shiftEndStr = frm.doc.shift_end;

        // If shift fields aren't present but a `shift` link exists, try to fetch shift timings
        if ((!shiftStartStr || !shiftEndStr) && frm.doc.shift) {
            frappe.db.get_doc('Shift Type', frm.doc.shift).then(shift => {
                if (shift) {
                    determine_and_apply(frm, checkMoment, shift.start_time || shift.start, shift.end_time || shift.end);
                }
            }).catch(() => {});
            return;
        }

        determine_and_apply(frm, checkMoment, shiftStartStr, shiftEndStr);
    } catch (e) {
        console.error(e);
    }
}

// ---------------- Validation helpers ----------------
function ensure_coordinates_then_validate(frm) {
    if (!frm.doc.latitude || !frm.doc.longitude) {
        if (navigator.geolocation) {
            frappe.msgprint(__('Obtaining current location — please wait...'));
            navigator.geolocation.getCurrentPosition(
                function(pos) {
                    frm.set_value('latitude', pos.coords.latitude);
                    frm.set_value('longitude', pos.coords.longitude);
                    if (typeof handle_position === 'function') {
                        handle_position(frm, pos);
                    }
                    // proceed to validation
                    setTimeout(function() {
                        proceed_validation(frm);
                    }, 250);
                },
                function(err) {
                    frappe.msgprint(__('Unable to get current location: {0}', [err.message || err.code]));
                },
                { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
            );
        } else {
            frappe.msgprint(__('Geolocation is not supported by this device.'));
        }
    } else {
        proceed_validation(frm);
    }
}

function proceed_validation(frm) {
    // compute check moment
    let time_val = frm.doc.time || (frappe.datetime && frappe.datetime.now_datetime && frappe.datetime.now_datetime());
    let checkMoment = time_val ? moment(time_val) : moment();
    if (!checkMoment.isValid()) checkMoment = moment();

    // Helper to finish: set skip flag and call save
    const allow_save = function() {
        frm._skip_validation = true;
        frm.save();
    };

    // Need shift times
    let shiftStartStr = frm.doc.shift_start;
    let shiftEndStr = frm.doc.shift_end;

    const validate_with_shift = function(sStartStr, sEndStr) {
        if (!sStartStr || !sEndStr) {
            frappe.msgprint(__('No shift period found. Check-in / Check-out not allowed.'));
            return;
        }

        // parse and align
        let sStart = moment(sStartStr, ['HH:mm:ss', 'HH:mm']);
        let sEnd = moment(sEndStr, ['HH:mm:ss', 'HH:mm']);
        sStart.year(checkMoment.year()); sStart.month(checkMoment.month()); sStart.date(checkMoment.date());
        sEnd.year(checkMoment.year()); sEnd.month(checkMoment.month()); sEnd.date(checkMoment.date());
        if (sEnd.isBefore(sStart)) sEnd.add(1, 'day');

        // fetch grace periods from server
        frappe.call({
            method: 'auditors.auditors.api.get_attendance_grace',
            callback: function(r) {
                const data = (r && r.message) || { late_entry: 60, early_exit: 5, after_end_allow: 60 };

                const pre_start_window = 60; // minutes before shift start allowed to check-in
                const late_allowed = Number(data.late_entry || 60);
                const early_allowed = Number(data.early_exit || 5);
                const after_end_allow = Number(data.after_end_allow || 60);

                // decide IN or OUT by nearest boundary
                const diffToStart = Math.abs(checkMoment.diff(sStart, 'minutes'));
                const diffToEnd = Math.abs(checkMoment.diff(sEnd, 'minutes'));
                const mode = diffToStart <= diffToEnd ? 'IN' : 'OUT';

                if (mode === 'IN') {
                    const windowStart = sStart.clone().subtract(pre_start_window, 'minutes');
                    const windowEnd = sStart.clone().add(late_allowed, 'minutes');
                    if (checkMoment.isBefore(windowStart) || checkMoment.isAfter(windowEnd)) {
                        frappe.msgprint(__('Check-in not allowed. Allowed window: {0} to {1}', [windowStart.format('HH:mm'), windowEnd.format('HH:mm')]));
                        return;
                    }
                    // allowed
                    frm.set_value('log_type', 'IN');
                    frm.set_value('shift_actual_start', checkMoment.format('HH:mm:ss'));
                    allow_save();
                } else {
                    // OUT
                    const windowStart = sEnd.clone().subtract(early_allowed, 'minutes');
                    const windowEnd = sEnd.clone().add(after_end_allow, 'minutes');
                    if (checkMoment.isBefore(windowStart) || checkMoment.isAfter(windowEnd)) {
                        frappe.msgprint(__('Check-out not allowed. Allowed window: {0} to {1}', [windowStart.format('HH:mm'), windowEnd.format('HH:mm')]));
                        return;
                    }
                    frm.set_value('log_type', 'OUT');
                    frm.set_value('shift_actual_end', checkMoment.format('HH:mm:ss'));
                    allow_save();
                }
            }
        });
    };

    // If shift strings present, validate immediately; else try to fetch by linked `shift` field; if none, block
    if (shiftStartStr && shiftEndStr) {
        validate_with_shift(shiftStartStr, shiftEndStr);
    } else if (frm.doc.shift) {
        frappe.db.get_doc('Shift Type', frm.doc.shift).then(shift => {
            if (shift) {
                validate_with_shift(shift.start_time || shift.start, shift.end_time || shift.end);
            } else {
                frappe.msgprint(__('No shift period found. Check-in / Check-out not allowed.'));
            }
        }).catch(() => {
            frappe.msgprint(__('Unable to fetch shift details.'));
        });
    } else {
        frappe.msgprint(__('No shift assigned. Cannot create check-in/check-out.'));
    }
}

function determine_and_apply(frm, checkMoment, shiftStartStr, shiftEndStr) {
    if (!shiftStartStr || !shiftEndStr) return;

    // parse shift times (expecting 'HH:mm' or 'HH:mm:ss') and align them to the same date
    let sStart = moment(shiftStartStr, ['HH:mm:ss', 'HH:mm']);
    let sEnd = moment(shiftEndStr, ['HH:mm:ss', 'HH:mm']);
    // align to check date
    sStart.year(checkMoment.year()); sStart.month(checkMoment.month()); sStart.date(checkMoment.date());
    sEnd.year(checkMoment.year()); sEnd.month(checkMoment.month()); sEnd.date(checkMoment.date());
    if (sEnd.isBefore(sStart)) sEnd.add(1, 'day');

    // pick nearest boundary to decide IN vs OUT
    let diffToStart = Math.abs(checkMoment.diff(sStart, 'minutes'));
    let diffToEnd = Math.abs(checkMoment.diff(sEnd, 'minutes'));
    let new_log = diffToStart <= diffToEnd ? 'IN' : 'OUT';

    if (frm.doc.log_type !== new_log) {
        frm.set_value('log_type', new_log);
    }

    // set actual shift start/end and alert on delay for IN
    if (new_log === 'IN') {
        frm.set_value('shift_actual_start', checkMoment.format('HH:mm:ss'));
        // delay threshold in minutes (changeable)
        let delay_minutes = 10;
        if (checkMoment.isAfter(sStart.clone().add(delay_minutes, 'minutes'))) {
            let late_by = checkMoment.diff(sStart, 'minutes');
            frappe.msgprint({
                title: __('Late check-in'),
                message: __('You are late by {0} minutes', [late_by]),
                indicator: 'orange'
            });
        }
    } else {
        frm.set_value('shift_actual_end', checkMoment.format('HH:mm:ss'));
    }
}
