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

    const validate_with_shift = function(shiftObjOrStart, maybeEnd) {
        // Normalize to a shift-like object: { start: ..., end: ..., ... }
        let shiftObj = {};
        if (typeof shiftObjOrStart === 'object') {
            shiftObj = shiftObjOrStart;
        } else {
            shiftObj.start = shiftObjOrStart;
            shiftObj.end = maybeEnd;
        }

        if (!shiftObj.start || !shiftObj.end) {
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

                // resolve shift location (Shift Location doctype) if present on shift
                const resolve_shift_location = function(shift) {
                    return new Promise(function(resolve) {
                        const loc_name = shift.shift_location || shift.location || shift.shift_location_name || shift.shift_location_type || shift.shift_location_id;
                        if (loc_name) {
                            frappe.db.get_doc('Shift Location', loc_name).then(loc => {
                                if (loc) {
                                    resolve({
                                        lat: loc.latitude || loc.lat || null,
                                        lon: loc.longitude || loc.lon || null,
                                        radius: Number(loc.checkin_radius || loc.radius || 300)
                                    });
                                } else {
                                    resolve(null);
                                }
                            }).catch(() => resolve(null));
                        } else if (shift.latitude && shift.longitude) {
                            resolve({ lat: shift.latitude, lon: shift.longitude, radius: Number(shift.checkin_radius || 300) });
                        } else {
                            resolve(null);
                        }
                    });
                };

                resolve_shift_location(shiftObj).then(function(locInfo) {
                    const latTo = locInfo ? locInfo.lat : (frm.doc.branch_latitude || null);
                    const lonTo = locInfo ? locInfo.lon : (frm.doc.branch_longitude || null);
                    const distance_threshold = locInfo ? (locInfo.radius || 300) : 300;

                    // compute distance to target location and require reason if far
                    const distMeters = compute_distance_simple(frm.doc.latitude, frm.doc.longitude, latTo, lonTo);
                    if (distMeters != null && latTo != null && lonTo != null && distMeters > distance_threshold) {
                        frappe.msgprint({
                            title: __('Far from office'),
                            message: __('You are {0} m away from your office. Please provide a reason.', [distMeters]),
                            indicator: 'red'
                        });
                        // set reason required and focus
                        try {
                            frm.set_df_property('reason', 'reqd', 1);
                            if (frm.fields_dict && frm.fields_dict.reason && frm.fields_dict.reason.$input) {
                                frm.fields_dict.reason.$input.focus();
                            }
                        } catch (e) {}
                        if (!frm.doc.reason) {
                            return;
                        }
                    } else {
                        // clear required flag if within radius
                        try { frm.set_df_property('reason', 'reqd', 0); } catch (e) {}
                    }

                    // proceed with time-window validation
                    proceed_after_location_check();
                });
                // end resolve_shift_location
                return; // location async will call proceed_after_location_check

                // decide IN or OUT by nearest boundary
                const diffToStart = Math.abs(checkMoment.diff(sStart, 'minutes'));
                const diffToEnd = Math.abs(checkMoment.diff(sEnd, 'minutes'));
                const mode = diffToStart <= diffToEnd ? 'IN' : 'OUT';

                const proceed_after_location_check = function() {
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
                };
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
        // No shift set on the checkin; try to fetch employee default shift
        if (frm.doc.employee) {
            frappe.db.get_doc('Employee', frm.doc.employee).then(emp => {
                if (emp) {
                    // try several common field names for default shift
                    const shift_field = emp.default_shift || emp.default_shift_type || emp.shift || emp.shift_type || emp.default_shift_type_name;
                    if (shift_field) {
                        frappe.db.get_doc('Shift Type', shift_field).then(shift => {
                            if (shift) {
                                validate_with_shift(shift.start_time || shift.start, shift.end_time || shift.end);
                            } else {
                                frappe.msgprint(__('No shift period found on default shift type.'));
                            }
                        }).catch(() => frappe.msgprint(__('Unable to fetch Shift Type from employee default')));
                    } else {
                        frappe.msgprint(__('No shift assigned to employee. Cannot create check-in/check-out.'));
                    }
                } else {
                    frappe.msgprint(__('Employee record not found.'));
                }
            }).catch(() => {
                frappe.msgprint(__('Unable to fetch employee details.'));
            });
        } else {
            frappe.msgprint(__('No shift assigned. Cannot create check-in/check-out.'));
        }
    }
}

function compute_distance_simple(lat1, lon1, lat2, lon2) {
    const a = Number(lat1), b = Number(lon1), c = Number(lat2), d = Number(lon2);
    if ([a, b, c, d].some(v => !isFinite(v))) return null;
    const toRad = x => (x * Math.PI) / 180;
    const R = 6371000;
    const φ1 = toRad(a);
    const φ2 = toRad(c);
    const Δφ = toRad(c - a);
    const Δλ = toRad(d - b);
    const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const dist = Math.round(2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
    return dist;
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
