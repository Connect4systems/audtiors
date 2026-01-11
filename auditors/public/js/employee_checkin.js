console.log('Employee Checkin client script loaded successfully');

frappe.ui.form.on('Employee Checkin', {
    refresh: function(frm) {
        console.log('Employee Checkin form refresh triggered');
        
        // Display map and address if coordinates are available
        if (frm.doc.latitude && frm.doc.longitude) {
            display_location_map(frm);
            fetch_and_display_address(frm);
            calculate_and_display_distance(frm);
        }
    },
    latitude: function(frm) {
        if (frm.doc.latitude && frm.doc.longitude) {
            display_location_map(frm);
            fetch_and_display_address(frm);
            calculate_and_display_distance(frm);
        }
    },
    longitude: function(frm) {
        if (frm.doc.latitude && frm.doc.longitude) {
            display_location_map(frm);
            fetch_and_display_address(frm);
            calculate_and_display_distance(frm);
        }
    },
    before_save: function(frm) {
        console.log('Employee Checkin before_save triggered', {
            skip_validation: frm._skip_validation,
            has_lat: !!frm.doc.latitude,
            has_lon: !!frm.doc.longitude
        });
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
    }
});

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

    // Need shift times - check if present on checkin form first
    let shiftStartStr = frm.doc.shift_start;
    let shiftEndStr = frm.doc.shift_end;

    const validate_with_shift = function(shiftObjOrStart, maybeEnd) {
        // Normalize to a shift-like object: { start: ..., end: ..., ... }
        let shiftObj = {};
        if (typeof shiftObjOrStart === 'object' && shiftObjOrStart !== null) {
            shiftObj = shiftObjOrStart;
            shiftObj.start = shiftObj.start_time || shiftObj.start;
            shiftObj.end = shiftObj.end_time || shiftObj.end;
        } else {
            shiftObj.start = shiftObjOrStart;
            shiftObj.end = maybeEnd;
        }

        if (!shiftObj.start || !shiftObj.end) {
            frappe.msgprint(__('No shift period found. Check-in / Check-out not allowed.'));
            return;
        }

        // parse and align
        let sStart = moment(shiftObj.start, ['HH:mm:ss', 'HH:mm']);
        let sEnd = moment(shiftObj.end, ['HH:mm:ss', 'HH:mm']);
        sStart.year(checkMoment.year()); sStart.month(checkMoment.month()); sStart.date(checkMoment.date());
        sEnd.year(checkMoment.year()); sEnd.month(checkMoment.month()); sEnd.date(checkMoment.date());
        if (sEnd.isBefore(sStart)) sEnd.add(1, 'day');

        // Use grace periods from Shift Type settings (not HR Settings)
        const pre_start_window = Number(shiftObj.begin_check_in_before_shift_start_time || 60);
        const late_allowed = Number(shiftObj.late_entry_grace_period || 60);
        const early_allowed = Number(shiftObj.early_exit_grace_period || 30);
        const after_end_allow = Number(shiftObj.allow_check_out_after_shift_end_time || 300);
        const enable_late_marking = shiftObj.enable_late_entry_marking || 0;
        const enable_early_marking = shiftObj.enable_early_exit_marking || 0;

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
                // Check if late and show alert (only if late marking is enabled)
                if (enable_late_marking && checkMoment.isAfter(sStart)) {
                    const late_by = checkMoment.diff(sStart, 'minutes');
                    frappe.msgprint({
                        title: __('Late Check-in'),
                        message: __('You are checking in {0} minutes late. Shift started at {1}.', [late_by, sStart.format('HH:mm')]),
                        indicator: 'orange'
                    });
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
                // Check if early and show alert (only if early marking is enabled)
                if (enable_early_marking && checkMoment.isBefore(sEnd)) {
                    const early_by = sEnd.diff(checkMoment, 'minutes');
                    frappe.msgprint({
                        title: __('Early Check-out'),
                        message: __('You are checking out {0} minutes early. Shift ends at {1}.', [early_by, sEnd.format('HH:mm')]),
                        indicator: 'orange'
                    });
                }
                frm.set_value('log_type', 'OUT');
                frm.set_value('shift_actual_end', checkMoment.format('HH:mm:ss'));
                allow_save();
            }
        };

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
                // Set log type automatically based on shift before showing dialog
                if (!frm.doc.log_type || frm.doc.log_type === '') {
                    frm.set_value('log_type', mode);
                }
                
                // set reason required and focus
                try {
                    frm.set_df_property('reason', 'reqd', 1);
                } catch (e) {}
                
                // If no reason provided yet, prompt user with dialog
                if (!frm.doc.reason || frm.doc.reason.trim() === '') {
                    frappe.prompt({
                        label: __('Reason'),
                        fieldname: 'reason',
                        fieldtype: 'Small Text',
                        reqd: 1,
                        description: __('You are {0} m away from your office. Please provide a reason.', [distMeters])
                    }, function(values) {
                        // User provided reason, set it and proceed
                        frm.set_value('reason', values.reason);
                        // Wait for value to be set, then proceed
                        setTimeout(function() {
                            proceed_after_location_check();
                        }, 100);
                    }, __('Far from office'), __('Submit'));
                    return;
                }
            } else {
                // clear required flag if within radius
                try { frm.set_df_property('reason', 'reqd', 0); } catch (e) {}
            }

            // proceed with time-window validation
            proceed_after_location_check();
        });
    };

    // If shift strings present, validate immediately; else try to fetch by linked `shift` field; if none, block
    if (shiftStartStr && shiftEndStr) {
        validate_with_shift(shiftStartStr, shiftEndStr);
    } else if (frm.doc.shift) {
        frappe.db.get_doc('Shift Type', frm.doc.shift).then(shift => {
            if (shift) {
                validate_with_shift(shift);
            } else {
                frappe.msgprint(__('No shift period found. Check-in / Check-out not allowed.'));
            }
        }).catch(() => {
            frappe.msgprint(__('Unable to fetch shift details.'));
        });
    } else {
        // No shift set on the checkin; fetch from last active Shift Assignment
        if (frm.doc.employee) {
            const today = frappe.datetime.now_date();
            frappe.call({
                method: 'frappe.client.get_list',
                args: {
                    doctype: 'Shift Assignment',
                    filters: {
                        employee: frm.doc.employee,
                        status: 'Active',
                        start_date: ['<=', today],
                        docstatus: 1
                    },
                    fields: ['name', 'shift_type', 'shift_location'],
                    order_by: 'start_date desc',
                    limit: 1
                },
                callback: function(r) {
                    if (r.message && r.message.length > 0) {
                        const assignment = r.message[0];
                        if (assignment.shift_type) {
                            frappe.db.get_doc('Shift Type', assignment.shift_type).then(shift => {
                                if (shift) {
                                    // Attach shift_location from assignment if available
                                    if (assignment.shift_location) {
                                        shift.shift_location = assignment.shift_location;
                                    }
                                    validate_with_shift(shift);
                                } else {
                                    frappe.msgprint(__('Shift Type not found.'));
                                }
                            }).catch((err) => {
                                console.error('Error fetching Shift Type:', err);
                                frappe.msgprint(__('Unable to fetch Shift Type: {0}', [assignment.shift_type]));
                            });
                        } else {
                            frappe.msgprint(__('No shift type in assignment.'));
                        }
                    } else {
                        frappe.msgprint(__('No active shift assignment found for today. Cannot create check-in/check-out.'));
                    }
                }
            });
        } else {
            frappe.msgprint(__('No employee selected. Cannot create check-in/check-out.'));
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

// ---------------- Map and Address Display Functions ----------------
function display_location_map(frm) {
    // Remove existing map if any
    if (frm.fields_dict.geolocation && frm.fields_dict.geolocation.$wrapper) {
        frm.fields_dict.geolocation.$wrapper.empty();
        
        const lat = frm.doc.latitude;
        const lon = frm.doc.longitude;
        
        // Create map container
        const mapHtml = `
            <div style="margin: 10px 0;">
                <div id="checkin_map" style="height: 300px; width: 100%; border: 1px solid #d1d8dd; border-radius: 4px;"></div>
                <div style="margin-top: 10px; padding: 10px; background: #f5f7fa; border-radius: 4px;">
                    <div style="display: flex; gap: 20px; flex-wrap: wrap;">
                        <div style="flex: 1; min-width: 200px;">
                            <strong>📍 Location:</strong>
                            <div id="address_display" style="margin-top: 5px; color: #666;">Loading address...</div>
                        </div>
                        <div style="min-width: 150px;">
                            <strong>📏 Distance:</strong>
                            <div id="distance_display" style="margin-top: 5px; color: #666; font-size: 16px; font-weight: bold;">
                                ${frm.doc.distance_in_meters || 0} meters
                            </div>
                        </div>
                    </div>
                    <div style="margin-top: 8px; font-size: 12px; color: #888;">
                        Coordinates: ${lat.toFixed(6)}, ${lon.toFixed(6)}
                    </div>
                </div>
            </div>
        `;
        
        frm.fields_dict.geolocation.$wrapper.html(mapHtml);
        
        // Initialize the map using Leaflet (if available) or Google Maps
        setTimeout(() => {
            try {
                if (typeof L !== 'undefined') {
                    // Use Leaflet
                    const map = L.map('checkin_map').setView([lat, lon], 15);
                    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        attribution: '© OpenStreetMap contributors'
                    }).addTo(map);
                    
                    // Add marker
                    const marker = L.marker([lat, lon]).addTo(map);
                    marker.bindPopup(`<b>Check-in Location</b><br>${lat.toFixed(6)}, ${lon.toFixed(6)}`).openPopup();
                    
                    // Add office location if available
                    if (frm.doc.branch_latitude && frm.doc.branch_longitude) {
                        const officeMarker = L.marker([frm.doc.branch_latitude, frm.doc.branch_longitude], {
                            icon: L.icon({
                                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
                                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
                                iconSize: [25, 41],
                                iconAnchor: [12, 41],
                                popupAnchor: [1, -34],
                                shadowSize: [41, 41]
                            })
                        }).addTo(map);
                        officeMarker.bindPopup('<b>Office Location</b>');
                        
                        // Draw line between locations
                        L.polyline([[lat, lon], [frm.doc.branch_latitude, frm.doc.branch_longitude]], {
                            color: 'blue',
                            weight: 2,
                            opacity: 0.6,
                            dashArray: '5, 10'
                        }).addTo(map);
                        
                        // Fit bounds to show both markers
                        map.fitBounds([
                            [lat, lon],
                            [frm.doc.branch_latitude, frm.doc.branch_longitude]
                        ]);
                    }
                } else {
                    // Fallback to Google Maps static image
                    const staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=15&size=600x300&markers=color:blue%7C${lat},${lon}&key=YOUR_API_KEY`;
                    document.getElementById('checkin_map').innerHTML = `
                        <a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank">
                            <img src="https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=15&size=600x300&markers=color:blue%7C${lat},${lon}" 
                                 style="width: 100%; height: 100%; object-fit: cover;" 
                                 onerror="this.parentElement.innerHTML='<div style=\\'padding:20px;text-align:center;\\'><a href=\\'https://www.google.com/maps?q=${lat},${lon}\\' target=\\'_blank\\'  style=\\'color:#2490ef;\\'>View on Google Maps →</a></div>'">
                        </a>
                    `;
                }
            } catch (e) {
                console.error('Map initialization error:', e);
                document.getElementById('checkin_map').innerHTML = `
                    <div style="padding: 20px; text-align: center;">
                        <a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" style="color: #2490ef;">
                            📍 View Location on Google Maps →
                        </a>
                    </div>
                `;
            }
        }, 100);
    }
}

function fetch_and_display_address(frm) {
    const lat = frm.doc.latitude;
    const lon = frm.doc.longitude;
    
    // Use Nominatim (OpenStreetMap) for reverse geocoding
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`)
        .then(response => response.json())
        .then(data => {
            let address = data.display_name || 'Address not found';
            
            // Try to format a shorter, more readable address
            if (data.address) {
                const parts = [];
                if (data.address.road) parts.push(data.address.road);
                if (data.address.suburb || data.address.neighbourhood) parts.push(data.address.suburb || data.address.neighbourhood);
                if (data.address.city || data.address.town) parts.push(data.address.city || data.address.town);
                if (data.address.state) parts.push(data.address.state);
                if (parts.length > 0) {
                    address = parts.join(', ');
                }
            }
            
            const addressDiv = document.getElementById('address_display');
            if (addressDiv) {
                addressDiv.innerHTML = address;
                addressDiv.style.color = '#333';
            }
            
            // Update form fields if they exist
            if (frm.fields_dict.area) frm.set_value('area', data.address?.suburb || data.address?.neighbourhood || '');
            if (frm.fields_dict.city) frm.set_value('city', data.address?.city || data.address?.town || '');
            if (frm.fields_dict.state) frm.set_value('state', data.address?.state || '');
        })
        .catch(error => {
            console.error('Error fetching address:', error);
            const addressDiv = document.getElementById('address_display');
            if (addressDiv) {
                addressDiv.innerHTML = 'Unable to fetch address';
                addressDiv.style.color = '#999';
            }
        });
}

function calculate_and_display_distance(frm) {
    const lat1 = frm.doc.latitude;
    const lon1 = frm.doc.longitude;
    const lat2 = frm.doc.branch_latitude;
    const lon2 = frm.doc.branch_longitude;
    
    if (lat1 && lon1 && lat2 && lon2) {
        const distance = compute_distance_simple(lat1, lon1, lat2, lon2);
        
        if (distance !== null) {
            frm.set_value('distance_in_meters', distance);
            
            const distanceDiv = document.getElementById('distance_display');
            if (distanceDiv) {
                const km = (distance / 1000).toFixed(2);
                distanceDiv.innerHTML = `${distance} m (${km} km)`;
                
                // Color code based on distance
                if (distance > 300) {
                    distanceDiv.style.color = '#e74c3c';
                } else {
                    distanceDiv.style.color = '#27ae60';
                }
            }
        }
    }
}
