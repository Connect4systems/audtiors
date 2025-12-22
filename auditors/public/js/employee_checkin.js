frappe.ui.form.on('Employee Checkin', {
    refresh: function(frm) {
        set_log_type_and_alert(frm);
    },
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
