import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Visit {
  id: string;
  turbine_id: string;
  technicians: string[];
  reason?: string | null;
  comment?: string | null;
  check_in: string; // ISO
  check_out?: string | null;
  power_plant?: string | null;
  equipment_name?: string | null;
  maintenance_company?: string | null;
  status?: string | null;
  malfunction_type?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  checkIn(payload: {
    turbineId?: string;
    technicians: string[];
    reason?: string;
    comment?: string;
    powerPlant?: string;
    equipmentName?: string;
    maintenanceCompany?: string;
    status?: string; // IN/OUT
    malfunctionType?: string;
  }): Observable<{ visit: Visit }> {
    return this.http.post<{ visit: Visit }>(`/api/visits/checkin`, payload);
  }

  checkout(visitId: string): Observable<{ visitId: string; checkOut: string }> {
    return this.http.post<{ visitId: string; checkOut: string }>(`/api/visits/checkout`, { visitId });
  }

  getActiveVisit(turbineId: string): Observable<{ visit: Visit | null }> {
    return this.http.get<{ visit: Visit | null }>(`/api/visits/active`, { params: { turbineId } });
  }

  getVisitById(id: string): Observable<{ visit: Visit }> {
    return this.http.get<{ visit: Visit }>(`/api/visits/${id}`);
  }

  getActiveSite(powerPlant: string): Observable<{ count: number; visits: Visit[] }> {
    return this.http.get<{ count: number; visits: Visit[] }>(`/api/visits/active-site`, { params: { powerPlant } });
  }
}
