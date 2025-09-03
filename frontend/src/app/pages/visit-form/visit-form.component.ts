import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators, FormArray, FormControl, FormGroup } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiService, Visit } from '../../services/api.service';
import { TranslateModule } from '@ngx-translate/core';
import { TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-visit-form',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, TranslateModule],
  templateUrl: './visit-form.component.html',
  styleUrls: ['./visit-form.component.scss']
})
export class VisitFormComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private fb = inject(FormBuilder);
  private api = inject(ApiService);
  private i18n = inject(TranslateService);

  turbineId = signal<string | null>(null); // deprecated (kept for compatibility, not required)
  loading = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  activeVisit = signal<Visit | null>(null);
  coActivity = signal<number>(0);
  currentLang = signal<string>('en');
  showEquipmentFromUrl = signal<boolean>(false);

  // Client-side submit rate limiting (5 attempts within 60s)
  submitLockedUntil = signal<number | null>(null); // epoch ms
  countdownSeconds = signal<number>(0);
  private submitAttemptTimes: number[] = []; // epoch ms
  private countdownTimer: any = null;

  form = this.fb.group({
    powerPlant: ['', []],
    equipmentName: [''],
    maintenanceCompany: [''],
    status: ['IN', [Validators.required]], // IN/OUT
    malfunctionType: [''],
    technicians: this.fb.array<FormGroup<any>>([
      this.fb.group({
        name: this.fb.control<string>('', { nonNullable: true, validators: [Validators.required] }),
        number: this.fb.control<string>('', { nonNullable: true, validators: [] })
      })
    ]),
    reason: [''],
    comment: ['']
  });

  get techniciansFA() {
    return this.form.get('technicians') as FormArray<FormGroup<{name: FormControl<string>; number: FormControl<string>}>>;
  }

  startNewForm() {
    // Clear active visit and errors, prefill from last IN, set status to IN
    this.activeVisit.set(null);
    this.error.set(null);
    this.success.set(null);
    const pp = this.form.value.powerPlant || '';
    if (pp) {
      this.restoreLastIn(pp);
    }
    this.form.patchValue({ status: 'IN' });
  }

  ngOnInit(): void {
    this.route.queryParamMap.subscribe((params) => {
      // i18n init: default to browser, allow URL override
      this.i18n.setDefaultLang('en');
      const urlLang = (params.get('lang') || '').toLowerCase();
      const navLang = (typeof navigator !== 'undefined' ? navigator.language.slice(0,2) : 'en').toLowerCase();
      const candidate = urlLang || navLang || 'en';
      const chosen = ['en','fr','es','pt'].includes(candidate) ? candidate : 'en';
      this.setLanguage(chosen);

      // Turbine ID is optional now; do not fetch active by turbine
      const tId = params.get('turbineId');
      this.turbineId.set(tId);
      this.success.set(null);
      this.error.set(null);

      // URL prefill
      const park = params.get('park') || params.get('powerPlant') || '';
      const equipment = params.get('Equipment Name') || params.get('equipmentName') || '';
      if (park) this.form.patchValue({ powerPlant: park });
      if (equipment) {
        this.form.patchValue({ equipmentName: equipment });
        this.showEquipmentFromUrl.set(true);
      } else {
        this.showEquipmentFromUrl.set(false);
      }

      // Restore persisted values for same powerPlant
      this.restorePersisted();

      // Co-activity check
      const pp = this.form.value.powerPlant || '';
      if (pp) {
        this.api.getActiveSite(pp).subscribe({
          next: ({ count }) => this.coActivity.set(count),
          error: () => this.coActivity.set(0)
        });
      }

      // Restore last submission (same day) and flip IN/OUT (keyed by powerPlant only)
      this.restoreLastSubmission(this.form.value.powerPlant || '');
    });
  }

  private fetchActive(turbineId: string) {
    this.loading.set(true);
    this.api.getActiveVisit(turbineId).subscribe({
      next: ({ visit }) => {
        this.activeVisit.set(visit);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set((err?.error?.error || 'Failed to load active visit') + ' - Call 0660530071');
        this.loading.set(false);
      }
    });
  }

  onCheckIn() {
    this.error.set(null);
    this.success.set(null);

    // Block if client-side lock is active
    if (this.isSubmitLocked()) {
      const secs = this.countdownSeconds();
      this.error.set(`Please wait ${secs}s before submitting again.`);
      return;
    }

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const technicians = this.techniciansFA.controls
      .map((group) => {
        const name = String(group.get('name')!.value || '').trim();
        const number = String(group.get('number')!.value || '').trim();
        if (!name) return '';
        return number ? `${name} (${number})` : name;
      })
      .filter((s) => s.length > 0);
    if (technicians.length === 0) {
      this.error.set('Please provide at least one technician name');
      return;
    }

    // Record attempt and possibly lock before sending
    this.recordSubmitAttempt();
    this.loading.set(true);
    this.api
      .checkIn({
        technicians,
        reason: this.form.value.reason || undefined,
        comment: this.form.value.comment || undefined,
        powerPlant: this.form.value.powerPlant || undefined,
        equipmentName: this.form.value.equipmentName || undefined,
        maintenanceCompany: this.form.value.maintenanceCompany || undefined,
        status: this.form.value.status || undefined,
        malfunctionType: this.form.value.malfunctionType || undefined,
      })
      .subscribe({
        next: ({ visit }) => {
          this.activeVisit.set(visit);
          this.success.set('Checked in successfully');
          this.loading.set(false);
          this.persistValues();
          // Save an IN snapshot for future prefilling
          this.saveLastIn(this.form.value.powerPlant || '');
          this.saveLastSubmission(this.form.value.powerPlant || '', this.form.value.status || 'IN', visit);
        },
        error: (err) => {
          if (err?.status === 503 && err?.error?.code === 'SITE_BLOCKED') {
            // Display required English message when site is blocked
            this.error.set('Website not accessible. Please call 09 72 68 10 30.');
          } else {
            this.error.set((err?.error?.error || 'Check-in failed') + ' - Call 0660530071');
          }
          this.loading.set(false);
        }
      });
  }

  onCheckout() {
    const visit = this.activeVisit();
    if (!visit) return;

    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);

    this.api.checkout(visit.id).subscribe({
      next: ({ checkOut }) => {
        this.activeVisit.set(null);
        this.success.set('Checked out at ' + new Date(checkOut).toLocaleString() + ' - Please rearm alarms');
        this.loading.set(false);
        // Mark last submission as OUT (do not overwrite last IN snapshot)
        this.saveLastSubmission(this.form.value.powerPlant || '', 'OUT', null);
      },
      error: (err) => {
        this.error.set((err?.error?.error || 'Checkout failed') + ' - Call 0660530071');
        this.loading.set(false);
      }
    });
  }

  addTechnician() {
    this.techniciansFA.push(this.fb.group({
      name: this.fb.control<string>('', { nonNullable: true }),
      number: this.fb.control<string>('', { nonNullable: true })
    }));
  }

  removeTechnician(index: number) {
    if (this.techniciansFA.length > 1) {
      this.techniciansFA.removeAt(index);
    }
  }

  clearAll() {
    // Keep park and equipment name from current URL-bound values
    const pp = this.form.value.powerPlant || '';
    const eq = this.form.value.equipmentName || '';

    this.error.set(null);
    this.success.set(null);

    // Reset the whole form but preserve powerPlant/equipmentName
    this.form.reset({
      powerPlant: pp,
      equipmentName: eq,
      maintenanceCompany: '',
      status: 'IN',
      malfunctionType: '',
      reason: '',
      comment: ''
    });

    // Reset technicians to a single empty row
    while (this.techniciansFA.length) this.techniciansFA.removeAt(0);
    this.techniciansFA.push(this.fb.group({
      name: this.fb.control<string>('', { nonNullable: true }),
      number: this.fb.control<string>('', { nonNullable: true })
    }));
  }

  private persistValues() {
    const pp = this.form.value.powerPlant || '';
    if (!pp) return;
    const key = `visit_pref_${pp}`;
    const data = {
      equipmentName: this.form.value.equipmentName || '',
      maintenanceCompany: this.form.value.maintenanceCompany || '',
      status: this.form.value.status || 'IN',
      malfunctionType: this.form.value.malfunctionType || '',
      technicians: this.techniciansFA.controls.map((c) => String(c.value || '')),
      reason: this.form.value.reason || '',
      comment: this.form.value.comment || '',
    };
    localStorage.setItem(key, JSON.stringify(data));
  }

  private restorePersisted() {
    const pp = this.form.value.powerPlant || '';
    if (!pp) return;
    const key = `visit_pref_${pp}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.equipmentName && !this.form.value.equipmentName) this.form.patchValue({ equipmentName: data.equipmentName });
      if (data.maintenanceCompany) this.form.patchValue({ maintenanceCompany: data.maintenanceCompany });
      if (data.status) this.form.patchValue({ status: data.status });
      if (data.malfunctionType) this.form.patchValue({ malfunctionType: data.malfunctionType });
      if (Array.isArray(data.technicians)) {
        // reset technicians
        while (this.techniciansFA.length) this.techniciansFA.removeAt(0);
        data.technicians.forEach((t: string) => this.techniciansFA.push(this.fb.group({
          name: this.fb.control<string>(t || '', { nonNullable: true }),
          number: this.fb.control<string>('', { nonNullable: true })
        })));
        if (this.techniciansFA.length === 0) this.techniciansFA.push(this.fb.group({
          name: this.fb.control<string>('', { nonNullable: true }),
          number: this.fb.control<string>('', { nonNullable: true })
        }));
      }
      if (data.reason) this.form.patchValue({ reason: data.reason });
      if (data.comment) this.form.patchValue({ comment: data.comment });
    } catch {}
  }

  private todayKey() {
    const now = new Date();
    return now.toISOString().slice(0,10); // YYYY-MM-DD
  }

  private lastSubmissionKey(powerPlant: string) {
    return `visit_last_${powerPlant || 'na'}`;
  }

  private lastInKey(powerPlant: string) {
    return `visit_last_in_${powerPlant || 'na'}`;
  }

  private lastGlobalInKey() {
    return `visit_last_in_global`;
  }

  private saveLastSubmission(powerPlant: string, status: string, visit: Visit | null) {
    const key = this.lastSubmissionKey(powerPlant);
    const payload = {
      date: this.todayKey(),
      status: status || 'IN',
      form: this.form.getRawValue(),
      visit: visit || null
    };
    localStorage.setItem(key, JSON.stringify(payload)); // replaces any existing (suppress first)
  }

  private saveLastIn(powerPlant: string) {
    const key = this.lastInKey(powerPlant);
    const payload = {
      date: this.todayKey(),
      form: this.form.getRawValue()
    };
    localStorage.setItem(key, JSON.stringify(payload));
    // Also save a global snapshot to allow cross-park prefilling
    try {
      localStorage.setItem(this.lastGlobalInKey(),JSON.stringify(payload));
    } catch {}
  }

  private restoreLastSubmission(powerPlant: string) {
    const key = this.lastSubmissionKey(powerPlant);
    try {
      // Always try to prefill from the most recent IN (per-park or global)
      if (powerPlant) {
        this.restoreLastIn(powerPlant);
      } else {
        this.restoreLastIn('');
      }

      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.date !== this.todayKey()) return; // only same day
      if (data.form) {
        // Prefill with last data (but DO NOT override powerPlant/equipmentName; they are URL-controlled)
        this.form.patchValue({
          maintenanceCompany: data.form.maintenanceCompany ?? this.form.value.maintenanceCompany,
          status: data.status || this.form.value.status,
          malfunctionType: data.form.malfunctionType ?? this.form.value.malfunctionType,
          reason: data.form.reason ?? this.form.value.reason,
          comment: data.form.comment ?? this.form.value.comment,
        });
        if (Array.isArray(data.form.technicians)) {
          while (this.techniciansFA.length) this.techniciansFA.removeAt(0);
          data.form.technicians.forEach((t: any) => {
            const name = typeof t === 'string' ? t : (t?.name || '');
            const number = typeof t === 'string' ? '' : (t?.number || '');
            this.techniciansFA.push(this.fb.group({
              name: this.fb.control<string>(name, { nonNullable: true }),
              number: this.fb.control<string>(number, { nonNullable: true })
            }));
          });
          if (this.techniciansFA.length === 0) this.techniciansFA.push(this.fb.group({
            name: this.fb.control<string>('', { nonNullable: true }),
            number: this.fb.control<string>('', { nonNullable: true })
          }));
        }
        // If previously IN and we have a visit snapshot, show active visit
        const prev = String(data.status || 'IN').toUpperCase();
        if (prev === 'IN' && data.visit && data.visit.id) {
          this.activeVisit.set(data.visit as Visit);
        } else if (prev === 'OUT') {
          // If last action was OUT, prefill from last IN snapshot and set status to IN
          this.restoreLastIn(powerPlant);
          this.form.patchValue({ status: 'IN' });
        } else {
          // Otherwise, flip status for second submission
          const next = prev === 'IN' ? 'OUT' : 'IN';
          this.form.patchValue({ status: next });
        }
      }
    } catch {}
  }

  private restoreLastIn(powerPlant: string) {
    const key = this.lastInKey(powerPlant);
    try {
      let raw = localStorage.getItem(key);
      let data = raw ? JSON.parse(raw) : null;
      console.log('restoring last IN', key, data);
      // Fallback to global last IN if no per-park snapshot exists
      if (!raw) {
        console.log('no per-park snapshot, falling back to global');
        const gRaw = localStorage.getItem(this.lastGlobalInKey());
        data = gRaw ? JSON.parse(gRaw) : null;
        console.log('global snapshot', gRaw, data);
      }
      if (!data?.form) return;
      this.form.patchValue({
        maintenanceCompany: data.form.maintenanceCompany ?? this.form.value.maintenanceCompany,
        malfunctionType: data.form.malfunctionType ?? this.form.value.malfunctionType,
        reason: data.form.reason ?? this.form.value.reason,
        comment: data.form.comment ?? this.form.value.comment,
      });
      if (Array.isArray(data.form.technicians)) {
        while (this.techniciansFA.length) this.techniciansFA.removeAt(0);
        data.form.technicians.forEach((t: any) => {
          const name = typeof t === 'string' ? t : (t?.name || '');
          const number = typeof t === 'string' ? '' : (t?.number || '');
          this.techniciansFA.push(this.fb.group({
            name: this.fb.control<string>(name, { nonNullable: true }),
            number: this.fb.control<string>(number, { nonNullable: true })
          }));
        });
        if (this.techniciansFA.length === 0) this.techniciansFA.push(this.fb.group({
          name: this.fb.control<string>('', { nonNullable: true }),
          number: this.fb.control<string>('', { nonNullable: true })
        }));
      }
    } catch {}
  }

  setLanguage(lang: string) {
    const chosen = ['en','fr','es','pt'].includes(lang) ? lang : 'en';
    this.currentLang.set(chosen);
    this.i18n.use(chosen);
    localStorage.setItem('visit_lang', chosen);
  }

  // ---- Client-side rate limit helpers ----
  isSubmitLocked(): boolean {
    const until = this.submitLockedUntil();
    return until !== null && Date.now() < until;
  }

  private recordSubmitAttempt() {
    const now = Date.now();
    const windowMs = 60_000; // 60 seconds
    // Keep only attempts within the last 60 seconds
    this.submitAttemptTimes = this.submitAttemptTimes.filter((t) => now - t < windowMs);
    this.submitAttemptTimes.push(now);
    if (this.submitAttemptTimes.length >= 5 && !this.isSubmitLocked()) {
      // Lock for the remainder of the 60s window
      const first = this.submitAttemptTimes[0];
      const lockMs = Math.max(0, windowMs - (now - first));
      this.submitLockedUntil.set(now + lockMs);
      this.startCountdown(lockMs);
    }
  }

  private startCountdown(initialMs: number) {
    // Clear any prior timer
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    const end = Date.now() + initialMs;
    const tick = () => {
      const remainingMs = Math.max(0, end - Date.now());
      const secs = Math.ceil(remainingMs / 1000);
      this.countdownSeconds.set(secs);
      if (remainingMs <= 0) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.submitLockedUntil.set(null);
        this.countdownSeconds.set(0);
        // reset the window
        this.submitAttemptTimes = [];
      }
    };
    tick();
    this.countdownTimer = setInterval(tick, 500);
  }
}
