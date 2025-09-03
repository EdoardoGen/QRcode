import { Routes } from '@angular/router';

import { VisitFormComponent } from './pages/visit-form/visit-form.component';

export const routes: Routes = [
  { path: '', component: VisitFormComponent },
  { path: '**', redirectTo: '' }
];
