import { Field } from '@ark-ui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { logger } from '@/shared/lib/logger'
import { Button } from '@/shared/ui/button'
import { type GreetingValues, greetingSchema } from '../model/greeting.schema'
import styles from './greeting-form.module.scss'

export function GreetingForm() {
  const { t } = useTranslation()
  const [greeted, setGreeted] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<GreetingValues>({
    resolver: zodResolver(greetingSchema),
    defaultValues: { name: '' },
  })

  const onSubmit = (values: GreetingValues) => {
    logger.info('greeting submitted', values)
    setGreeted(values.name)
  }

  return (
    <section className={styles.card}>
      <h2 className={styles.heading}>{t('greeting.heading')}</h2>

      <form className={styles.form} onSubmit={handleSubmit(onSubmit)} noValidate>
        <Field.Root invalid={Boolean(errors.name)}>
          <Field.Label className={styles.label}>{t('greeting.nameLabel')}</Field.Label>
          <Field.Input
            className={styles.input}
            placeholder={t('greeting.namePlaceholder')}
            {...register('name')}
          />
          {errors.name?.message && (
            // The resolver hands back a translation key, not a sentence.
            <Field.ErrorText className={styles.error}>{t(errors.name.message)}</Field.ErrorText>
          )}
        </Field.Root>

        <div>
          <Button type="submit" disabled={isSubmitting}>
            {t('greeting.submit')}
          </Button>
        </div>
      </form>

      {greeted && <p className={styles.result}>{t('greeting.result', { name: greeted })}</p>}
    </section>
  )
}
