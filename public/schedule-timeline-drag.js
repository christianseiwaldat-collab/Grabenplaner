(function registerScheduleTimelineDrag(global) {
  "use strict";

  const dragStepMinutes = 15;
  const dragThreshold = 5;
  const timeText = minutes => String(Math.floor(minutes / 60)).padStart(2, "0")
    + ":" + String(minutes % 60).padStart(2, "0");

  function proposedTimes(shift, edge, movement) {
    const { startMinute, endMinute, minMinute, maxMinute } = shift;
    const delta = Math.round(movement / dragStepMinutes) * dragStepMinutes;
    let start = startMinute;
    let end = endMinute;
    if (edge === "start") {
      start = Math.max(minMinute, Math.min(end - 1, start + delta));
    } else if (edge === "end") {
      end = Math.min(maxMinute, Math.max(start + 1, end + delta));
    } else {
      const duration = end - start;
      start = Math.max(minMinute, Math.min(maxMinute - duration, start + delta));
      end = start + duration;
    }
    return start >= minMinute && end <= maxMinute && start < end ? { start, end } : null;
  }

  function bind(timeline, { readShift, save, reportInvalid }) {
    const doc = timeline.ownerDocument;
    const scroller = timeline.closest(".timeline-scroll");
    let drag = null;
    let suppressClick = false;
    let scrollFrame = 0;

    function laneAtPoint(event, shift) {
      const day = doc.elementFromPoint(event.clientX, event.clientY)
        ?.closest(".day-body")?.closest("[data-timeline-date]");
      if (!day || !timeline.contains(day)) return null;
      const lane = [...day.querySelectorAll("[data-timeline-employee]")]
        .find(entry => entry.dataset.timelineEmployee === shift.employeeNumber);
      return { day, lane };
    }

    function minuteAtPointer(event, lane, range) {
      const rect = lane.getBoundingClientRect();
      return (event.clientY - rect.top) / rect.height * range;
    }

    function clearPreview(active) {
      active.preview?.remove();
      active.preview = null;
    }

    function cancel() {
      if (!drag) return;
      const active = drag;
      drag = null;
      if (scrollFrame) global.cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      if (active.started) suppressClick = true;
      clearPreview(active);
      active.button.classList.remove("shift-drag-source");
      timeline.classList.remove("timeline-is-dragging");
      if (active.button.hasPointerCapture(active.pointerId)) {
        active.button.releasePointerCapture(active.pointerId);
      }
    }

    function drawPreview(active, lane, times) {
      const { gridStart, range } = active;
      if (!active.preview) {
        active.preview = doc.createElement("span");
        active.preview.className = "shift-bar shift-drag-preview";
        active.preview.setAttribute("aria-hidden", "true");
        for (const variable of ["--employee-color", "--employee-contrast"]) {
          active.preview.style.setProperty(variable, active.button.style.getPropertyValue(variable));
        }
      }
      if (active.preview.parentElement !== lane) lane.append(active.preview);
      active.preview.style.top = (times.start - gridStart) / range * 100 + "%";
      active.preview.style.height = Math.max(2.5, (times.end - times.start) / range * 100) + "%";
      active.preview.textContent = timeText(times.start) + "–" + timeText(times.end);
    }

    function update(event) {
      const active = drag;
      if (!active || active.pointerId !== event.pointerId) return;
      if (!active.started) {
        if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < dragThreshold) return;
        active.started = true;
        active.button.classList.add("shift-drag-source");
        timeline.classList.add("timeline-is-dragging");
      }

      const target = active.edge
        ? { lane: active.sourceLane, day: active.sourceLane.closest("[data-timeline-date]") }
        : laneAtPoint(event, active.shift);
      active.change = null;
      active.rejection = "";
      if (!target) {
        clearPreview(active);
        return;
      }
      if (!target.lane?.dataset.date) {
        clearPreview(active);
        active.rejection = target.lane?.dataset.shiftDropReason
          || "Für dieses Teammitglied gibt es an dem Tag kein verfügbares Feld.";
        return;
      }
      const movement = minuteAtPointer(event, target.lane, active.range) - active.pointerMinute;
      const times = proposedTimes(active.shift, active.edge, movement);
      if (!times) {
        clearPreview(active);
        active.rejection = "Der Dienst muss innerhalb der zulässigen Planungszeit liegen.";
        return;
      }
      active.change = {
        date: target.day.dataset.timelineDate,
        startTime: timeText(times.start),
        endTime: timeText(times.end),
      };
      drawPreview(active, target.lane, times);
    }

    function scrollDirection(event) {
      if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return 0;
      const { left, right, top, bottom } = scroller.getBoundingClientRect();
      const { clientX: x, clientY: y } = event;
      if (x < left || x > right || y < top || y > bottom) return 0;
      if (x < left + 30) return -1;
      return x > right - 30 ? 1 : 0;
    }

    function scrollTowardPointer() {
      scrollFrame = 0;
      const event = drag?.lastPointer;
      if (!event) return;
      const direction = scrollDirection(event);
      if (!direction) return;
      const before = scroller.scrollLeft;
      scroller.scrollLeft += direction * 12;
      if (scroller.scrollLeft === before) return;
      update(event);
      scrollFrame = global.requestAnimationFrame(scrollTowardPointer);
    }

    timeline.addEventListener("pointerdown", event => {
      if (drag || !event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      const button = event.target.closest("[data-shift-draggable]");
      if (!button) return;
      const shift = readShift(button.dataset.shiftId);
      if (!shift) return;
      const sourceLane = button.closest("[data-timeline-employee]");
      const gridStart = Number(timeline.dataset.startMinute);
      const range = Number(timeline.dataset.endMinute) - gridStart;
      if (!sourceLane || !(range > 0) || sourceLane.getBoundingClientRect().height <= 0) return;
      button.setPointerCapture(event.pointerId);
      drag = {
        button, shift, sourceLane, gridStart, range,
        edge: event.target.closest("[data-shift-edge]")?.dataset.shiftEdge,
        pointerId: event.pointerId, pointerMinute: minuteAtPointer(event, sourceLane, range),
        x: event.clientX, y: event.clientY, started: false,
      };
    });
    timeline.addEventListener("pointermove", event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      update(event);
      if (!drag.started || drag.edge) return;
      drag.lastPointer = event;
      if (!scrollFrame && scrollDirection(event)) {
        scrollFrame = global.requestAnimationFrame(scrollTowardPointer);
      }
    });
    timeline.addEventListener("pointerup", event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      update(event);
      const { shift, started, change, rejection } = drag;
      cancel();
      if (!started) return;
      if (rejection) {
        reportInvalid(rejection);
        return;
      }
      if (change && (change.date !== shift.date || change.startTime !== timeText(shift.startMinute)
        || change.endTime !== timeText(shift.endMinute))) {
        void save(shift, change);
      }
    });
    for (const type of ["pointercancel", "lostpointercapture"]) {
      timeline.addEventListener(type, event => { if (drag?.pointerId === event.pointerId) cancel(); });
    }
    timeline.addEventListener("click", event => {
      if (!suppressClick || event.detail === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = false;
    }, true);
    doc.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !drag) return;
      event.preventDefault();
      cancel();
    });

    return { cancel };
  }

  global.GPScheduleTimelineDrag = Object.freeze({ bind });
})(typeof window !== "undefined" ? window : globalThis);
